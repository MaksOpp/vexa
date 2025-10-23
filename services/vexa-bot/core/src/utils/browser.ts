/**
 * Browser context utilities and services
 * These classes run inside page.evaluate() browser context
 */

/**
 * Generate UUID for browser context
 */
export function generateBrowserUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  } else {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      function (c) {
        var r = (Math.random() * 16) | 0,
          v = c == "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }
    );
  }
}

/**
 * Browser-compatible AudioService for browser context
 */
export class BrowserAudioService {
  private config: any;
  private processor: any = null;
  private audioContext: AudioContext | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  constructor(config: any) {
    this.config = config;
  }

  async findMediaElements(retries: number = 5, delay: number = 2000): Promise<HTMLMediaElement[]> {
    for (let i = 0; i < retries; i++) {
      const mediaElements = Array.from(
        document.querySelectorAll("audio, video")
      ).filter((el: any) => 
        !el.paused && 
        el.srcObject instanceof MediaStream && 
        el.srcObject.getAudioTracks().length > 0
      ) as HTMLMediaElement[];

      if (mediaElements.length > 0) {
        (window as any).logBot(`Found ${mediaElements.length} active media elements with audio tracks after ${i + 1} attempt(s).`);
        return mediaElements;
      }
      (window as any).logBot(`[Audio] No active media elements found. Retrying in ${delay}ms... (Attempt ${i + 2}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return [];
  }

  async createCombinedAudioStream(mediaElements: HTMLMediaElement[]): Promise<MediaStream> {
    if (mediaElements.length === 0) {
      throw new Error("No media elements provided for audio stream creation");
    }

    (window as any).logBot(`Found ${mediaElements.length} active media elements.`);
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    if (!this.destinationNode) {
      this.destinationNode = this.audioContext.createMediaStreamDestination();
    }
    let sourcesConnected = 0;

    // Connect all media elements to the destination node
    mediaElements.forEach((element: any, index: number) => {
      try {
        // Ensure element is actually audible
        if (typeof element.muted === "boolean") element.muted = false;
        if (typeof element.volume === "number") element.volume = 1.0;
        if (typeof element.play === "function") {
          element.play().catch(() => {});
        }

        const elementStream =
          element.srcObject ||
          (element.captureStream && element.captureStream()) ||
          (element.mozCaptureStream && element.mozCaptureStream());

        // Debug audio tracks and unmute them
        if (elementStream instanceof MediaStream) {
          const audioTracks = elementStream.getAudioTracks();
          (window as any).logBot(`Element ${index + 1}: Found ${audioTracks.length} audio tracks`);
          audioTracks.forEach((track, trackIndex) => {
            (window as any).logBot(`  Track ${trackIndex}: enabled=${track.enabled}, muted=${track.muted}, label=${track.label}`);
            
            // Unmute muted audio tracks
            if (track.muted) {
              track.enabled = true;
              // Force unmute by setting muted to false
              try {
                (track as any).muted = false;
                (window as any).logBot(`  Unmuted track ${trackIndex} (enabled=${track.enabled}, muted=${track.muted})`);
              } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                (window as any).logBot(`  Could not unmute track ${trackIndex}: ${message}`);
              }
            }
          });
        }

        if (
          elementStream instanceof MediaStream &&
          elementStream.getAudioTracks().length > 0
        ) {
          // Connect regardless of the read-only muted flag; WebAudio can still pull samples
          const sourceNode = this.audioContext!.createMediaStreamSource(elementStream);
          sourceNode.connect(this.destinationNode!);
          sourcesConnected++;
          (window as any).logBot(`Connected audio stream from element ${index + 1}/${mediaElements.length}. Tracks=${elementStream.getAudioTracks().length}`);
        } else {
          (window as any).logBot(`Skipping element ${index + 1}: No audio tracks found`);
        }
      } catch (error: any) {
        (window as any).logBot(`Could not connect element ${index + 1}: ${error.message}`);
      }
    });

    if (sourcesConnected === 0) {
      throw new Error("Could not connect any audio streams. Check media permissions.");
    }

    (window as any).logBot(`Successfully combined ${sourcesConnected} audio streams.`);
    return this.destinationNode!.stream;
  }

  async initializeAudioProcessor(combinedStream: MediaStream): Promise<any> {
    // Reuse existing context if available
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    if (!this.destinationNode) {
      this.destinationNode = this.audioContext.createMediaStreamDestination();
    }

    const mediaStream = this.audioContext.createMediaStreamSource(combinedStream);
    const recorder = this.audioContext.createScriptProcessor(
      this.config.bufferSize,
      this.config.inputChannels,
      this.config.outputChannels
    );
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = 0; // Silent playback

    // Connect the audio processing pipeline
    mediaStream.connect(recorder);
    recorder.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    this.processor = {
      audioContext: this.audioContext,
      destinationNode: this.destinationNode,
      recorder,
      mediaStream,
      gainNode,
      sessionAudioStartTimeMs: null
    };

    try { await this.audioContext.resume(); } catch {}
    (window as any).logBot("Audio processing pipeline connected and ready.");
    return this.processor;
  }

  setupAudioDataProcessor(onAudioData: (audioData: Float32Array, sessionStartTime: number | null) => void): void {
    if (!this.processor) {
      throw new Error("Audio processor not initialized");
    }

    this.processor.recorder.onaudioprocess = async (event: any) => {
      // Set session start time on first audio chunk
      if (this.processor!.sessionAudioStartTimeMs === null) {
        this.processor!.sessionAudioStartTimeMs = Date.now();
        (window as any).logBot(`[Audio] Session audio start time set: ${this.processor!.sessionAudioStartTimeMs}`);
      }

      const inputData = event.inputBuffer.getChannelData(0);
      const resampledData = this.resampleAudioData(inputData, this.processor!.audioContext.sampleRate);
      
      onAudioData(resampledData, this.processor!.sessionAudioStartTimeMs);
    };
  }

  private resampleAudioData(inputData: Float32Array, sourceSampleRate: number): Float32Array {
    const targetLength = Math.round(
      inputData.length * (this.config.targetSampleRate / sourceSampleRate)
    );
    const resampledData = new Float32Array(targetLength);
    const springFactor = (inputData.length - 1) / (targetLength - 1);
    
    resampledData[0] = inputData[0];
    resampledData[targetLength - 1] = inputData[inputData.length - 1];
    
    for (let i = 1; i < targetLength - 1; i++) {
      const index = i * springFactor;
      const leftIndex = Math.floor(index);
      const rightIndex = Math.ceil(index);
      const fraction = index - leftIndex;
      resampledData[i] =
        inputData[leftIndex] +
        (inputData[rightIndex] - inputData[leftIndex]) * fraction;
    }
    
    return resampledData;
  }

  getSessionAudioStartTime(): number | null {
    return this.processor?.sessionAudioStartTimeMs || null;
  }

  disconnect(): void {
    if (this.processor) {
      try {
        this.processor.recorder.disconnect();
        this.processor.mediaStream.disconnect();
        this.processor.gainNode.disconnect();
        this.processor.audioContext.close();
        (window as any).logBot("Audio processing pipeline disconnected.");
      } catch (error: any) {
        (window as any).logBot(`Error disconnecting audio pipeline: ${error.message}`);
      }
      this.processor = null;
    }
  }
}

/**
 * Browser-compatible WhisperLiveService for browser context
 * Supports both simple and stubborn reconnection modes
 */
export class BrowserWhisperLiveService {
  private whisperLiveUrl: string;
  private socket: WebSocket | null = null;
  private isServerReady: boolean = false;
  private botConfigData: any;
  private currentUid: string | null = null;
  private onMessageCallback: ((data: any) => void) | null = null;
  private onErrorCallback: ((error: Event) => void) | null = null;
  private onCloseCallback: ((event: CloseEvent) => void) | null = null;
  private reconnectInterval: any = null;
  private retryCount: number = 0;
  private maxRetries: number = Number.MAX_SAFE_INTEGER; // TRULY NEVER GIVE UP!
  private retryDelayMs: number = 2000;
  private stubbornMode: boolean = false;

  constructor(config: any, stubbornMode: boolean = false) {
    this.whisperLiveUrl = config.whisperLiveUrl;
    this.stubbornMode = stubbornMode;
  }

  async connectToWhisperLive(
    botConfigData: any,
    onMessage: (data: any) => void,
    onError: (error: Event) => void,
    onClose: (event: CloseEvent) => void
  ): Promise<WebSocket | null> {
    // Store callbacks for reconnection
    this.botConfigData = botConfigData;
    this.onMessageCallback = onMessage;
    this.onErrorCallback = onError;
    this.onCloseCallback = onClose;

    if (this.stubbornMode) {
      return this.attemptConnection();
    } else {
      return this.simpleConnection();
    }
  }

  private async simpleConnection(): Promise<WebSocket | null> {
    try {
      this.socket = new WebSocket(this.whisperLiveUrl);
      
      this.socket.onopen = () => {
        this.currentUid = generateBrowserUUID();
        (window as any).logBot(`[Failover] WebSocket connection opened successfully to ${this.whisperLiveUrl}. New UID: ${this.currentUid}. Lang: ${this.botConfigData.language}, Task: ${this.botConfigData.task}`);
        
        const configPayload = {
          uid: this.currentUid,
          language: this.botConfigData.language || null,
          task: this.botConfigData.task || "transcribe",
          model: null,
          use_vad: false,
          platform: this.botConfigData.platform,
          token: this.botConfigData.token,
          meeting_id: this.botConfigData.nativeMeetingId,
          meeting_url: this.botConfigData.meetingUrl || null,
        };

        (window as any).logBot(`Sending initial config message: ${JSON.stringify(configPayload)}`);
        this.socket!.send(JSON.stringify(configPayload));
      };

      this.socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (this.onMessageCallback) {
          this.onMessageCallback(data);
        }
      };

      this.socket.onerror = this.onErrorCallback;
      this.socket.onclose = this.onCloseCallback;

      return this.socket;
    } catch (error: any) {
      (window as any).logBot(`[WhisperLive] Connection error: ${error.message}`);
      return null;
    }
  }

  private async attemptConnection(): Promise<WebSocket | null> {
    try {
      (window as any).logBot(`[STUBBORN] 🚀 Connecting to WhisperLive with NEVER-GIVE-UP reconnection: ${this.whisperLiveUrl} (attempt ${this.retryCount + 1})`);
      
      this.socket = new WebSocket(this.whisperLiveUrl);
      
      this.socket.onopen = (event) => {
        (window as any).logBot(`[STUBBORN] ✅ WebSocket CONNECTED to ${this.whisperLiveUrl}! Retry count reset from ${this.retryCount}.`);
        this.retryCount = 0; // Reset on successful connection
        this.clearReconnectInterval(); // Stop any ongoing reconnection attempts
        this.isServerReady = false; // Will be set to true when SERVER_READY received
        
        this.currentUid = generateBrowserUUID();
        const configPayload = {
          uid: this.currentUid,
          language: this.botConfigData.language || null,
          task: this.botConfigData.task || "transcribe",
          model: null,
          use_vad: false,
          platform: this.botConfigData.platform,
          token: this.botConfigData.token,
          meeting_id: this.botConfigData.nativeMeetingId,
          meeting_url: this.botConfigData.meetingUrl || null,
        };

        (window as any).logBot(`Sending initial config message: ${JSON.stringify(configPayload)}`);
        if (this.socket) {
          this.socket.send(JSON.stringify(configPayload));
        }
      };

      this.socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (this.onMessageCallback) {
          this.onMessageCallback(data);
        }
      };

      this.socket.onerror = (event) => {
        (window as any).logBot(`[STUBBORN] ❌ WebSocket ERROR. Will start stubborn reconnection...`);
        if (this.onErrorCallback) {
          this.onErrorCallback(event);
        }
        this.startStubbornReconnection();
      };

      this.socket.onclose = (event) => {
        (window as any).logBot(`[STUBBORN] ❌ WebSocket CLOSED. Code: ${event.code}, Reason: "${event.reason}". WILL RECONNECT NO MATTER WHAT!`);
        this.isServerReady = false;
        this.socket = null;
        if (this.onCloseCallback) {
          this.onCloseCallback(event);
        }
        this.startStubbornReconnection();
      };

      return this.socket;
    } catch (error: any) {
      (window as any).logBot(`[STUBBORN] ❌ Connection creation error: ${error.message}. WILL KEEP TRYING!`);
      this.startStubbornReconnection();
      return null;
    }
  }

  private startStubbornReconnection(): void {
    if (this.reconnectInterval) {
      return; // Already reconnecting
    }

    // Exponential backoff with max delay of 10 seconds
    const delay = Math.min(this.retryDelayMs * Math.pow(1.5, Math.min(this.retryCount, 10)), 10000);
    
    (window as any).logBot(`[STUBBORN] 🔄 Starting STUBBORN reconnection in ${delay}ms (attempt ${this.retryCount + 1}/∞ - WE NEVER GIVE UP!)...`);
    
    this.reconnectInterval = setTimeout(async () => {
      this.reconnectInterval = null;
      this.retryCount++;
      
      if (this.retryCount >= 1000) { // Reset counter every 1000 attempts to prevent overflow
        (window as any).logBot(`[STUBBORN] 🔄 Resetting retry counter after 1000 attempts. WE WILL NEVER GIVE UP! EVER!`);
        this.retryCount = 0; // Reset and keep going - NEVER GIVE UP!
      }
      
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        (window as any).logBot(`[STUBBORN] 🔄 Attempting reconnection (retry ${this.retryCount})...`);
        await this.attemptConnection();
      } else {
        (window as any).logBot(`[STUBBORN] ✅ Connection already restored!`);
      }
    }, delay);
  }

  private clearReconnectInterval(): void {
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  sendAudioData(audioData: Float32Array): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      // Send Float32Array directly as WhisperLive expects (matching google_old.ts approach)
      this.socket.send(audioData);
      return true;
    } catch (error: any) {
      (window as any).logBot(`[WhisperLive] Error sending audio data: ${error.message}`);
      return false;
    }
  }

  sendAudioChunkMetadata(chunkLength: number, sampleRate: number): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    const meta = {
      type: "audio_chunk_metadata",
      payload: {
        length: chunkLength,
        sample_rate: sampleRate,
        client_timestamp_ms: Date.now(),
      },
    };

    try {
      this.socket.send(JSON.stringify(meta));
      return true;
    } catch (error: any) {
      (window as any).logBot(`[WhisperLive] Error sending audio metadata: ${error.message}`);
      return false;
    }
  }

  sendSpeakerEvent(eventType: string, participantName: string, participantId: string, relativeTimestampMs: number, botConfigData: any): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    const speakerEventMessage = {
      type: "speaker_activity",
      payload: {
        event_type: eventType,
        participant_name: participantName,
        participant_id_meet: participantId,
        relative_client_timestamp_ms: relativeTimestampMs,
        uid: this.currentUid,
        token: botConfigData.token,
        platform: botConfigData.platform,
        meeting_id: botConfigData.nativeMeetingId,
        meeting_url: botConfigData.meetingUrl
      }
    };

    try {
      this.socket.send(JSON.stringify(speakerEventMessage));
      return true;
    } catch (error: any) {
      (window as any).logBot(`[WhisperLive] Error sending speaker event: ${error.message}`);
      return false;
    }
  }

  getCurrentUid(): string | null {
    return this.currentUid;
  }

  sendSessionControl(event: string, botConfigData: any): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    const sessionControlMessage = {
      type: "session_control",
      payload: {
        event: event,
        uid: generateBrowserUUID(),
        client_timestamp_ms: Date.now(),
        token: botConfigData.token,
        platform: botConfigData.platform,
        meeting_id: botConfigData.nativeMeetingId
      }
    };

    try {
      this.socket.send(JSON.stringify(sessionControlMessage));
      return true;
    } catch (error: any) {
      (window as any).logBot(`[WhisperLive] Error sending session control: ${error.message}`);
      return false;
    }
  }

  isReady(): boolean {
    return this.isServerReady;
  }

  setServerReady(ready: boolean): void {
    this.isServerReady = ready;
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close(): void {
    (window as any).logBot(`[STUBBORN] 🛑 Closing WebSocket and stopping reconnection...`);
    this.clearReconnectInterval();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

/**
 * BrowserCaptionService - Monitors and extracts Google Meet native captions
 */
export class BrowserCaptionService {
  private captionContainer: HTMLElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private sessionStartTime: number | null = null;
  private lastCaptionText: string = '';
  private lastCaptionTimestamp: number = 0;
  private captionSequenceStartTime: number = 0; // Track start of current caption sequence
  private captionSegmentId: number = 0;
  private config: any;
  private currentSpeaker: string = 'Unknown Speaker';

  constructor(config: any) {
    this.config = config;
  }

  /**
   * Find caption container element using multiple selectors
   */
  async findCaptionContainer(
    containerSelectors: string[],
    retries: number = 10,
    delay: number = 1000
  ): Promise<HTMLElement | null> {
    for (let attempt = 0; attempt < retries; attempt++) {
      for (const selector of containerSelectors) {
        try {
          const element = document.querySelector(selector) as HTMLElement;
          if (element) {
            // Log element found and check visibility
            const visible = this.isVisible(element);
            (window as any).logBot(`[Caption] Found element with selector "${selector}" - visible: ${visible}, display: ${getComputedStyle(element).display}`);
            
            // For caption containers, accept the element even if not strictly visible
            // The container might be in DOM but hidden until captions actually appear
            (window as any).logBot(`[Caption] Using caption container from selector: ${selector}`);
            this.captionContainer = element;
            return element;
          }
        } catch (e: any) {
          // Selector might be invalid, continue to next
          (window as any).logBot(`[Caption] Selector "${selector}" threw error: ${e.message}`);
        }
      }
      
      if (attempt < retries - 1) {
        (window as any).logBot(`[Caption] No caption container found. Retrying in ${delay}ms... (Attempt ${attempt + 2}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    (window as any).logBot(`[Caption] Warning: Could not find caption container after ${retries} attempts`);
    return null;
  }

  /**
   * Check if element is visible
   */
  private isVisible(element: HTMLElement): boolean {
    const cs = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      cs.opacity !== '0'
    );
  }

  /**
   * Start monitoring captions with periodic extraction (every 5 seconds)
   */
  startCaptionMonitoring(
    captionContainer: HTMLElement,
    onCaptionSegment: (segment: any) => void,
    getCurrentSpeaker?: () => string
  ): void {
    if (!captionContainer) {
      (window as any).logBot('[Caption] Error: No caption container provided');
      return;
    }

    // Initialize session start time
    if (!this.sessionStartTime) {
      this.sessionStartTime = Date.now();
    }

    (window as any).logBot('[Caption] Starting periodic caption extraction (every 5 seconds)');

    // Periodic extraction: check for new captions every 5 seconds
    // This gives Google Meet time to finalize the text before we capture it
    const extractionInterval = setInterval(() => {
      this.processCaptionChange(captionContainer, onCaptionSegment, getCurrentSpeaker);
    }, 5000); // Extract every 5 seconds

    // Store interval ID for cleanup
    (this as any).extractionInterval = extractionInterval;

    // Also do initial extraction immediately
    this.processCaptionChange(captionContainer, onCaptionSegment, getCurrentSpeaker);

    (window as any).logBot('[Caption] Periodic caption extraction started (every 5 seconds)');
  }

  /**
   * Process caption change and extract data
   */
  private processCaptionChange(
    captionContainer: HTMLElement,
    onCaptionSegment: (segment: any) => void,
    getCurrentSpeaker?: () => string
  ): void {
    try {
      const captionData = this.extractCaptionData(captionContainer);
      
      if (!captionData || !captionData.text) {
        return; // No caption text found
      }

      // Simple deduplication: only skip if EXACTLY the same text
      if (captionData.text === this.lastCaptionText) {
        (window as any).logBot(`[Caption] Skipping exact duplicate text`);
        return;
      }
      
      // Each 5-second extraction is a new snapshot - don't try to be smart about cumulative updates
      (window as any).logBot(`[Caption] Extracting 5-second snapshot`)

      // Get current speaker from external speaker detection if available
      if (getCurrentSpeaker && typeof getCurrentSpeaker === 'function') {
        try {
          const detectedSpeaker = getCurrentSpeaker();
          if (detectedSpeaker && detectedSpeaker !== 'Unknown Speaker') {
            this.currentSpeaker = detectedSpeaker;
          }
        } catch (e: any) {
          // Fallback to caption speaker or unknown
        }
      }

      // Use speaker from caption if available, otherwise use detected speaker
      const speaker = captionData.speaker || this.currentSpeaker;

      // Calculate timestamps - each 5-second snapshot gets a NEW time window
      const currentTime = Date.now();
      const startTime = currentTime - 5000; // Segment represents the last 5 seconds
      const endTime = currentTime;

      // Create transcription segment
      const segment = {
        id: this.captionSegmentId++,
        text: captionData.text,
        speaker: speaker,
        start: startTime,
        end: endTime,
        completed: true
      };

      // Update tracking
      this.lastCaptionText = captionData.text;
      this.lastCaptionTimestamp = currentTime;

      // Send segment to callback
      onCaptionSegment(segment);

      (window as any).logBot(`[Caption] ${speaker}: ${captionData.text}`);

    } catch (error: any) {
      (window as any).logBot(`[Caption] Error processing caption: ${error.message}`);
    }
  }

  /**
   * Extract caption text and speaker from DOM
   */
  private extractCaptionData(captionContainer: HTMLElement): { text: string; speaker: string | null } | null {
    try {
      let captionText = '';
      let speakerName: string | null = null;

      // Google Meet caption structure (as of 2024):
      // Container has multiple caption entries, we want the LAST (most recent) one
      // Each entry: <div class="nMcdL bj4p3b">
      //   - Speaker info container: <div> with <img> (avatar) and name span
      //   - Text: <div class="ygicle VbkSUe">Caption text here</div>
      
      // Find all caption entries (individual caption blocks)
      const captionEntries = captionContainer.querySelectorAll('.nMcdL, .bj4p3b, [class*="nMcdL"]');
      
      let targetEntry: HTMLElement | null = null;
      
      if (captionEntries.length > 0) {
        // Get the last (most recent) caption entry
        targetEntry = captionEntries[captionEntries.length - 1] as HTMLElement;
      } else {
        // Fallback: use the container itself if no entries found
        targetEntry = captionContainer;
      }

      if (!targetEntry) {
        return null;
      }

      // ROBUST APPROACH: Extract caption text first (it's easier to identify)
      // Try multiple selectors for caption text
      const textSelectors = [
        '.ygicle',          // Primary Google Meet caption text class
        '.VbkSUe',          // Secondary caption text class  
        '.ygicle.VbkSUe',   // Combined classes
        'div.ygicle',       // Specific div with caption class
        '[class*="ygicle"]' // Partial match
      ];

      let captionTextElement: HTMLElement | null = null;

      for (const selector of textSelectors) {
        try {
          const textElement = targetEntry.querySelector(selector) as HTMLElement;
          if (textElement) {
            captionText = textElement.textContent?.trim() || '';
            if (captionText) {
              captionTextElement = textElement;
              (window as any).logBot(`[Caption] Found text using selector ${selector}: ${captionText.substring(0, 50)}...`);
              break;
            }
          }
        } catch (e) {
          // Try next selector
        }
      }

      // ROBUST SPEAKER EXTRACTION:
      // Strategy 1: Find the container with avatar image, then get adjacent text
      // This is more robust as avatar images are structural elements
      const avatarImg = targetEntry.querySelector('img[src*="googleusercontent.com"]') as HTMLImageElement;
      
      if (avatarImg) {
        (window as any).logBot(`[Caption] Found avatar image, searching for speaker name nearby...`);
        
        // The speaker name is typically in a sibling div next to or near the image
        // Look for text in the same parent or nearby containers, excluding the caption text
        let searchRoot = avatarImg.parentElement;
        let attempts = 0;
        
        // Walk up the DOM tree a bit to find the common parent
        while (searchRoot && attempts < 3) {
          // Get all text content from this level
          const textNodes: string[] = [];
          
          // Find all text-containing elements
          const allElements = searchRoot.querySelectorAll('*');
          allElements.forEach((el: Element) => {
            const element = el as HTMLElement;
            // Skip if this is the caption text element
            if (captionTextElement && (element === captionTextElement || captionTextElement.contains(element))) {
              return;
            }
            
            // Get direct text content (not from children)
            const text = Array.from(element.childNodes)
              .filter((node: ChildNode) => node.nodeType === Node.TEXT_NODE)
              .map((node: ChildNode) => node.textContent?.trim() || '')
              .join(' ')
              .trim();
            
            if (text && text.length > 0 && text.length < 100) {
              textNodes.push(text);
            }
            
            // Also check spans with text content (likely speaker name)
            if (element.tagName === 'SPAN' && element.childNodes.length > 0) {
              const spanText = element.textContent?.trim() || '';
              if (spanText && spanText.length > 0 && spanText.length < 100 && 
                  spanText !== captionText && !textNodes.includes(spanText)) {
                textNodes.push(spanText);
              }
            }
          });
          
          // Filter out empty strings and the caption text
          const candidateNames = textNodes.filter(text => 
            text !== captionText && 
            text.length > 0 && 
            text.length < 100 &&
            !text.includes('googleusercontent.com') // Exclude URLs
          );
          
          if (candidateNames.length > 0) {
            // Usually the first valid text near an avatar is the speaker name
            speakerName = candidateNames[0];
            (window as any).logBot(`[Caption] Found speaker name near avatar: ${speakerName}`);
            break;
          }
          
          searchRoot = searchRoot.parentElement;
          attempts++;
        }
      }
      
      // Strategy 2: Fallback to finding text elements that are NOT the caption text
      if (!speakerName && captionTextElement) {
        (window as any).logBot(`[Caption] Avatar method failed, trying structural text extraction...`);
        
        // Get all text from the entry
        const allText = targetEntry.textContent?.trim() || '';
        
        // If the entry contains more text than just the caption, the extra text is likely the speaker
        if (allText !== captionText) {
          // Try to extract the speaker name by removing the caption text
          let possibleSpeaker = allText.replace(captionText, '').trim();
          
          // Clean up any extra whitespace
          possibleSpeaker = possibleSpeaker.replace(/\s+/g, ' ').trim();
          
          // Check if it looks like a reasonable name (not too long, not empty)
          if (possibleSpeaker && possibleSpeaker.length > 0 && possibleSpeaker.length < 100) {
            speakerName = possibleSpeaker;
            (window as any).logBot(`[Caption] Extracted speaker by text diff: ${speakerName}`);
          }
        }
      }
      
      // Strategy 3: Last resort - try class-based selectors (less robust but better than nothing)
      if (!speakerName) {
        (window as any).logBot(`[Caption] Structural methods failed, falling back to class selectors...`);
        
        const speakerSelectors = [
          '.NWpY1d',          // Primary Google Meet speaker class (less robust)
          '.adE6rb .NWpY1d',  // Nested speaker
          'span.NWpY1d',      // Specific span with speaker class
          '.speaker-name',    // Generic speaker class
          '[data-speaker-name]' // Data attribute
        ];

        for (const selector of speakerSelectors) {
          try {
            const speakerElement = targetEntry.querySelector(selector) as HTMLElement;
            if (speakerElement) {
              speakerName = speakerElement.textContent?.trim() || null;
              if (speakerName) {
                (window as any).logBot(`[Caption] Found speaker using fallback selector ${selector}: ${speakerName}`);
                break;
              }
            }
          } catch (e) {
            // Try next selector
          }
        }
      }

      // Filter out empty or very short captions
      if (!captionText || captionText.length < 2) {
        (window as any).logBot(`[Caption] Skipping empty or short caption: "${captionText}"`);
        return null;
      }

      (window as any).logBot(`[Caption] Extracted: Speaker="${speakerName}", Text="${captionText.substring(0, 50)}..."`);

      return {
        text: captionText,
        speaker: speakerName
      };

    } catch (error: any) {
      (window as any).logBot(`[Caption] Error extracting caption data: ${error.message}`);
      return null;
    }
  }

  /**
   * Get session start time
   */
  getSessionStartTime(): number | null {
    return this.sessionStartTime;
  }

  /**
   * Stop monitoring captions and cleanup
   */
  stopMonitoring(): void {
    // Clear periodic extraction interval
    const interval = (this as any).extractionInterval;
    if (interval) {
      clearInterval(interval);
      (this as any).extractionInterval = null;
      (window as any).logBot('[Caption] Stopped periodic caption extraction');
    }
    
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
  }

  /**
   * Set current speaker manually (for integration with speaker detection)
   */
  setCurrentSpeaker(speaker: string): void {
    this.currentSpeaker = speaker;
  }
}
