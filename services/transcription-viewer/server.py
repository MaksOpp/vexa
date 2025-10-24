"""
Real-time Transcription Viewer - AG-UI Server

This FastAPI server bridges the existing WebSocket transcription service
to an AG-UI compatible SSE frontend interface.
"""

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Optional

import httpx
import websockets
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration  
WS_URL = os.getenv("API_GATEWAY_WS_URL", "ws://localhost:18056/ws")  # WebSocket is in API Gateway!
API_BASE_URL = os.getenv("API_GATEWAY_URL", "http://localhost:18056")  # Use API Gateway for REST too
ADMIN_API_URL = os.getenv("ADMIN_API_URL", "http://localhost:18057")
ADMIN_TOKEN = os.getenv("ADMIN_API_TOKEN", "token")

app = FastAPI(title="Transcription Viewer", version="1.0.0")

# Cache for user API key - IMPORTANT: must reuse same key!
_cached_api_key: Optional[str] = None

async def get_or_create_api_key() -> str:
    """Get an API key for the viewer to use internally - uses most recent user's token"""
    global _cached_api_key
    
    # Return cached key if we already have one
    if _cached_api_key:
        logger.debug(f"Using cached API key: {_cached_api_key[:10]}...")
        return _cached_api_key
    
    try:
        # Get the list of users to find the most recent one
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Get all users
            users_response = await client.get(
                f"{ADMIN_API_URL}/admin/users",
                headers={"X-Admin-API-Key": ADMIN_TOKEN}
            )
            
            if users_response.status_code == 200:
                users = users_response.json()
                if users:
                    # Get the most recent user (highest ID)
                    latest_user = max(users, key=lambda u: u['id'])
                    user_id = latest_user['id']
                    
                    logger.info(f"Using user ID {user_id} for API key")
                    
                    # Try to create a token for this user
                    token_response = await client.post(
                        f"{ADMIN_API_URL}/admin/users/{user_id}/tokens",
                        headers={"X-Admin-API-Key": ADMIN_TOKEN}
                    )
                    
                    if token_response.status_code in (200, 201):
                        data = token_response.json()
                        _cached_api_key = data.get('token')
                        logger.info(f"Generated API key for user {user_id}: {_cached_api_key[:10]}...")
                        return _cached_api_key
    except Exception as e:
        logger.error(f"Exception generating API key: {e}")
    
    # This shouldn't happen - raise an error instead of using invalid default
    raise ValueError("Failed to generate API key for viewer. Check if services are running.")

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")


def format_timestamp(iso_timestamp: str) -> str:
    """Format ISO timestamp to HH:MM:SS"""
    try:
        dt = datetime.fromisoformat(iso_timestamp.replace('Z', '+00:00'))
        return dt.strftime("%H:%M:%S")
    except Exception:
        return iso_timestamp


async def fetch_initial_transcript(platform: str, native_id: str) -> list:
    """Fetch initial transcript via REST API"""
    api_key = await get_or_create_api_key()
    url = f"{API_BASE_URL}/transcripts/{platform}/{native_id}"
    headers = {"X-API-Key": api_key}
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=headers)
            if response.status_code == 200:
                data = response.json()
                return data.get('segments', [])
            else:
                logger.warning(f"REST API returned {response.status_code}: {response.text}")
                return []
    except Exception as e:
        logger.error(f"Failed to fetch initial transcript: {e}")
        return []


async def transcription_stream(
    meeting_id: str,
    language: Optional[str],
    platform: str
):
    """
    Stream transcriptions from WebSocket service to frontend via AG-UI protocol.
    
    This generator:
    1. Fetches initial transcript via REST
    2. Connects to WebSocket
    3. Subscribes to meeting
    4. Transforms WebSocket events to AG-UI events
    5. Streams to frontend
    """
    
    # Generate unique message ID
    message_id = f"msg_{datetime.now().timestamp()}"
    
    try:
        # Emit RUN_STARTED event
        yield {
            "event": "message",
            "data": json.dumps({
                "type": "RUN_STARTED",
                "message_id": message_id,
                "timestamp": datetime.now().isoformat()
            })
        }
        
        # Get API key for authentication
        api_key = await get_or_create_api_key()
        
        # Step 1: Bootstrap from REST API
        logger.info(f"Fetching initial transcript for {platform}:{meeting_id}")
        initial_segments = await fetch_initial_transcript(platform, meeting_id)
        
        if initial_segments:
            logger.info(f"Got {len(initial_segments)} initial segments")
            for segment in initial_segments:
                text = segment.get('text', '')
                speaker = segment.get('speaker', 'Unknown')
                start_time = format_timestamp(segment.get('absolute_start_time', ''))
                
                if text.strip():
                    formatted_line = f"[{start_time}] {speaker}: {text}\n"
                    
                    yield {
                        "event": "message",
                        "data": json.dumps({
                            "type": "TEXT_MESSAGE_CHUNK",
                            "message_id": message_id,
                            "delta": formatted_line,
                            "metadata": {
                                "speaker": speaker,
                                "timestamp": segment.get('absolute_start_time'),
                                "language": segment.get('language')
                            }
                        })
                    }
        
        # Step 2: Connect to WebSocket for live updates
        logger.info(f"Connecting to WebSocket at {WS_URL}")
        headers = [("X-API-Key", api_key)]
        
        async with websockets.connect(WS_URL, additional_headers=headers, ping_interval=None) as ws:
            logger.info("WebSocket connected")
            
            # Step 3: Subscribe to meeting
            subscribe_msg = {
                "action": "subscribe",
                "meetings": [{"platform": platform, "native_id": meeting_id}]
            }
            await ws.send(json.dumps(subscribe_msg))
            logger.info(f"Subscribed to {platform}:{meeting_id}")
            
            # Emit status update
            yield {
                "event": "message",
                "data": json.dumps({
                    "type": "TEXT_MESSAGE_CHUNK",
                    "message_id": message_id,
                    "delta": "\n--- Live transcription started ---\n\n"
                })
            }
            
            # Step 4: Process WebSocket messages
            async def pinger():
                """Send ping every 25 seconds"""
                while True:
                    try:
                        await asyncio.sleep(25.0)
                        await ws.send(json.dumps({"action": "ping"}))
                    except Exception:
                        break
            
            # Start ping task
            ping_task = asyncio.create_task(pinger())
            
            try:
                async for frame in ws:
                    try:
                        msg = json.loads(frame)
                        event_type = msg.get('type', 'unknown')
                        
                        # Handle transcript events
                        if event_type == "transcript.mutable":
                            payload = msg.get('payload', {})
                            segments = payload.get('segments', [])
                            
                            for segment in segments:
                                text = segment.get('text', '')
                                speaker = segment.get('speaker', 'Unknown')
                                
                                # Try to get timestamp
                                start_time = segment.get('absolute_start_time')
                                if start_time:
                                    start_time = format_timestamp(start_time)
                                else:
                                    # Fallback to numeric start if absolute not available
                                    start_val = segment.get('start')
                                    if start_val:
                                        start_time = f"{float(start_val):.1f}s"
                                    else:
                                        start_time = "??:??:??"
                                
                                if text.strip():
                                    formatted_line = f"[{start_time}] {speaker}: {text}\n"
                                    
                                    yield {
                                        "event": "message",
                                        "data": json.dumps({
                                            "type": "TEXT_MESSAGE_CHUNK",
                                            "message_id": message_id,
                                            "delta": formatted_line,
                                            "metadata": {
                                                "speaker": speaker,
                                                "timestamp": segment.get('absolute_start_time'),
                                                "language": segment.get('language')
                                            }
                                        })
                                    }
                        
                        elif event_type == "meeting.status":
                            status = msg.get('payload', {}).get('status', 'unknown')
                            logger.info(f"Meeting status: {status}")
                            
                            yield {
                                "event": "message",
                                "data": json.dumps({
                                    "type": "TEXT_MESSAGE_CHUNK",
                                    "message_id": message_id,
                                    "delta": f"\n[Status: {status}]\n"
                                })
                            }
                        
                        elif event_type == "subscribed":
                            meetings = msg.get('meetings', [])
                            logger.info(f"Subscribed to meetings: {meetings}")
                        
                        elif event_type == "pong":
                            pass  # Silent
                        
                        elif event_type == "error":
                            error = msg.get('error', 'unknown error')
                            logger.error(f"WebSocket error: {error}")
                            
                            yield {
                                "event": "message",
                                "data": json.dumps({
                                    "type": "RUN_ERROR",
                                    "message": error
                                })
                            }
                    
                    except json.JSONDecodeError:
                        logger.error(f"Non-JSON message: {frame}")
                    except Exception as e:
                        logger.error(f"Error processing message: {e}", exc_info=True)
            
            finally:
                ping_task.cancel()
                try:
                    await ping_task
                except asyncio.CancelledError:
                    pass
    
    except Exception as e:
        logger.error(f"Stream error: {e}", exc_info=True)
        yield {
            "event": "message",
            "data": json.dumps({
                "type": "RUN_ERROR",
                "message": str(e)
            })
        }
    
    finally:
        # Emit RUN_FINISHED event
        yield {
            "event": "message",
            "data": json.dumps({
                "type": "RUN_FINISHED",
                "message_id": message_id,
                "timestamp": datetime.now().isoformat()
            })
        }


@app.get("/")
async def root():
    """Serve the main HTML page"""
    from fastapi.responses import FileResponse
    return FileResponse("static/index.html")


@app.get("/transcribe")
async def transcribe(
    request: Request,
    meeting_id: str,
    platform: str = "google_meet",
    language: Optional[str] = None
):
    """
    SSE endpoint for streaming transcriptions using AG-UI protocol.
    
    Query parameters:
    - meeting_id: The native meeting ID (e.g., "tzo-qcxv-sbo")
    - platform: Platform type (default: "google_meet")
    - language: Optional language code (e.g., "pl")
    """
    logger.info(f"Starting transcription stream for {platform}:{meeting_id} (language={language})")
    
    return EventSourceResponse(
        transcription_stream(meeting_id, language, platform),
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "ws_url": WS_URL,
        "api_base_url": API_BASE_URL
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("VIEWER_PORT", "8090"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)

