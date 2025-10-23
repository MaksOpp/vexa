import { Page } from "playwright";
import { log } from "../../utils";
import { BotConfig } from "../../types";
import {
  googleParticipantSelectors,
  googleSpeakingClassNames,
  googleSilenceClassNames,
  googleParticipantContainerSelectors,
  googleNameSelectors,
  googleSpeakingIndicators,
  googlePeopleButtonSelectors,
  googleCaptionContainerSelectors
} from "./selectors";
import { enableGoogleMeetCaptions, waitForCaptionContainer } from "./captions";

/**
 * Start Google Meet caption-based recording
 * This replaces the old audio capture approach with direct caption extraction
 */
export async function startGoogleRecording(page: Page, botConfig: BotConfig): Promise<void> {
  log("[Google Meet] Starting caption-based recording...");

  // Step 1: Enable Google Meet captions (with optional language selection)
  const captionsEnabled = await enableGoogleMeetCaptions(page, botConfig.language || undefined);
  if (!captionsEnabled) {
    log("[Google Meet] Warning: Could not enable captions. Proceeding anyway...");
  }
  
  // Log the selected language
  if (botConfig.language) {
    log(`[Google Meet] Caption language requested: ${botConfig.language}`);
  } else {
    log(`[Google Meet] Using default caption language`);
  }

  // Step 2: Wait for caption container to appear
  const containerAppeared = await waitForCaptionContainer(page, googleCaptionContainerSelectors, 15000);
  if (!containerAppeared) {
    log("[Google Meet] Warning: Caption container did not appear. Captions may not be available.");
  }

  // Step 3: Load browser utility classes
  try {
    await page.addScriptTag({
      path: require('path').join(__dirname, '../../browser-utils.global.js'),
    });
  } catch (error: any) {
    log(`Warning: Could not load browser utils via addScriptTag: ${error.message}`);
    log("Attempting alternative loading method...");
    
    // Alternative: Load script content and evaluate it
    const fs = require('fs');
    const path = require('path');
    const scriptPath = path.join(__dirname, '../../browser-utils.global.js');
    
    try {
      const scriptContent = fs.readFileSync(scriptPath, 'utf8');
      await page.evaluate(async (script) => {
        try {
          // Use Trusted Types to inject inline script text, or fallback to Blob URL
          const injectWithTrustedTypes = () => {
            const policy = (window as any).trustedTypes?.createPolicy('vexaPolicy', {
              createScript: (s: string) => s,
              createScriptURL: (s: string) => s
            });
            const scriptEl = document.createElement('script');
            if (policy) {
              (scriptEl as any).text = policy.createScript(script);
              document.head.appendChild(scriptEl);
              return Promise.resolve();
            }
            return Promise.reject(new Error('Trusted Types not available'));
          };

          const injectWithBlobUrl = () => new Promise<void>((resolve, reject) => {
            try {
              const blob = new Blob([script], { type: 'text/javascript' });
              const url = URL.createObjectURL(blob);
              const policy = (window as any).trustedTypes?.createPolicy('vexaPolicy', {
                createScriptURL: (u: string) => u
              });
              const scriptEl = document.createElement('script');
              const finalUrl = policy ? (policy as any).createScriptURL(url) : url;
              (scriptEl as any).src = finalUrl as any;
              scriptEl.onload = () => {
                resolve();
              };
              scriptEl.onerror = (e) => {
                reject(new Error('Failed to load browser utils via blob URL'));
              };
              document.head.appendChild(scriptEl);
            } catch (err) {
              reject(err as any);
            }
          });

          try {
            await injectWithTrustedTypes();
          } catch {
            await injectWithBlobUrl();
          }

          const utils = (window as any).VexaBrowserUtils;
          if (!utils) {
            console.error('VexaBrowserUtils not found after injection');
          } else {
            console.log('VexaBrowserUtils loaded keys:', Object.keys(utils));
          }
        } catch (error) {
          console.error('Error injecting browser utils script:', (error as any)?.message || error);
          throw error;
        }
      }, scriptContent);
      log("Browser utils loaded and available as window.VexaBrowserUtils");
    } catch (evalError: any) {
      log(`Error loading browser utils via evaluate: ${evalError.message}`);
      throw new Error(`Failed to load browser utilities: ${evalError.message}`);
    }
  }

  // Step 4: Initialize caption monitoring in browser context
  await page.evaluate(
    async (pageArgs: {
      botConfigData: BotConfig;
      redisUrl: string;
      selectors: {
        participantSelectors: string[];
        speakingClasses: string[];
        silenceClasses: string[];
        containerSelectors: string[];
        nameSelectors: string[];
        speakingIndicators: string[];
        peopleButtonSelectors: string[];
        captionContainerSelectors: string[];
      };
    }) => {
      const { botConfigData, redisUrl, selectors } = pageArgs;

      // Use browser utility classes from the global bundle
      const browserUtils = (window as any).VexaBrowserUtils;
      (window as any).logBot(`Browser utils available: ${Object.keys(browserUtils || {}).join(', ')}`);

      await new Promise<void>((resolve, reject) => {
        try {
          (window as any).logBot("Starting Google Meet caption-based recording process.");
          
          // Initialize caption service
          const captionService = new browserUtils.BrowserCaptionService({});
          
          // Find caption container
          const selectorsTyped = selectors as any;
          captionService.findCaptionContainer(selectorsTyped.captionContainerSelectors).then(async (captionContainer: HTMLElement | null) => {
            if (!captionContainer) {
              reject(new Error("[Google Meet Caption Error] Could not find caption container"));
              return;
            }

            (window as any).logBot("[Caption] Caption container found, initializing monitoring...");

            // Track current speaker using speaker detection
            let currentSpeaker = 'Unknown Speaker';
            const speakingStates = new Map<string, string>();

            // Helper functions for speaker detection (same as before)
            function getGoogleParticipantId(element: HTMLElement) {
              let id = element.getAttribute('data-participant-id');
              if (!id) {
                const stableChild = element.querySelector('[jsinstance]') as HTMLElement | null;
                if (stableChild) {
                  id = stableChild.getAttribute('jsinstance') || undefined as any;
                }
              }
              if (!id) {
                if (!(element as any).dataset.vexaGeneratedId) {
                  (element as any).dataset.vexaGeneratedId = 'gm-id-' + Math.random().toString(36).substr(2, 9);
                }
                id = (element as any).dataset.vexaGeneratedId;
              }
              return id as string;
            }

            function getGoogleParticipantName(participantElement: HTMLElement) {
              const notranslate = participantElement.querySelector('span.notranslate') as HTMLElement | null;
              if (notranslate && notranslate.textContent && notranslate.textContent.trim()) {
                const t = notranslate.textContent.trim();
                if (t.length > 1 && t.length < 50) return t;
              }

              const nameSelectors: string[] = selectorsTyped.nameSelectors || [];
              for (const sel of nameSelectors) {
                const el = participantElement.querySelector(sel) as HTMLElement | null;
                if (el) {
                  let nameText = el.textContent || el.innerText || el.getAttribute('data-self-name') || el.getAttribute('aria-label') || '';
                  if (nameText) {
                    nameText = nameText.trim();
                    if (nameText && nameText.length > 1 && nameText.length < 50) return nameText;
                  }
                }
              }

              const selfName = participantElement.getAttribute('data-self-name');
              if (selfName && selfName.trim()) return selfName.trim();
              const idToDisplay = getGoogleParticipantId(participantElement);
              return `Google Participant (${idToDisplay})`;
            }

            function isVisible(el: HTMLElement): boolean {
              const cs = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              const ariaHidden = el.getAttribute('aria-hidden') === 'true';
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                cs.display !== 'none' &&
                cs.visibility !== 'hidden' &&
                cs.opacity !== '0' &&
                !ariaHidden
              );
            }

            function hasSpeakingIndicator(container: HTMLElement): boolean {
              const indicators: string[] = selectorsTyped.speakingIndicators || [];
              for (const sel of indicators) {
                const ind = container.querySelector(sel) as HTMLElement | null;
                if (ind && isVisible(ind)) return true;
              }
              return false;
            }

            function inferSpeakingFromClasses(container: HTMLElement, mutatedClassList?: DOMTokenList): { speaking: boolean } {
              const speakingClasses: string[] = selectorsTyped.speakingClasses || [];
              const silenceClasses: string[] = selectorsTyped.silenceClasses || [];

              const classList = mutatedClassList || container.classList;
              const descendantSpeaking = speakingClasses.some(cls => container.querySelector('.' + cls));
              const hasSpeaking = speakingClasses.some(cls => classList.contains(cls)) || descendantSpeaking;
              const hasSilent = silenceClasses.some(cls => classList.contains(cls));
              if (hasSpeaking) return { speaking: true };
              if (hasSilent) return { speaking: false };
              return { speaking: false };
            }

            function logGoogleSpeakerEvent(participantElement: HTMLElement, mutatedClassList?: DOMTokenList) {
              const participantId = getGoogleParticipantId(participantElement);
              const participantName = getGoogleParticipantName(participantElement);
              const previousLogicalState = speakingStates.get(participantId) || 'silent';

              const indicatorSpeaking = hasSpeakingIndicator(participantElement);
              const classInference = inferSpeakingFromClasses(participantElement, mutatedClassList);
              const isCurrentlySpeaking = indicatorSpeaking || classInference.speaking;

              if (isCurrentlySpeaking) {
                if (previousLogicalState !== 'speaking') {
                  (window as any).logBot(`🎤 [Google] SPEAKER_START: ${participantName} (ID: ${participantId})`);
                  currentSpeaker = participantName; // Update current speaker
                  captionService.setCurrentSpeaker(participantName); // Update caption service
                }
                speakingStates.set(participantId, 'speaking');
              } else {
                if (previousLogicalState === 'speaking') {
                  (window as any).logBot(`🔇 [Google] SPEAKER_END: ${participantName} (ID: ${participantId})`);
                  // Don't reset currentSpeaker immediately, caption might still be for this person
                }
                speakingStates.set(participantId, 'silent');
              }
            }

            function observeGoogleParticipant(participantElement: HTMLElement) {
              const participantId = getGoogleParticipantId(participantElement);
              speakingStates.set(participantId, 'silent');

              logGoogleSpeakerEvent(participantElement);

              const callback = function(mutationsList: MutationRecord[]) {
                for (const mutation of mutationsList) {
                  if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    const targetElement = mutation.target as HTMLElement;
                    if (participantElement.contains(targetElement) || participantElement === targetElement) {
                      logGoogleSpeakerEvent(participantElement, targetElement.classList);
                    }
                  }
                }
              };

              const observer = new MutationObserver(callback);
              observer.observe(participantElement, {
                attributes: true,
                attributeFilter: ['class'],
                subtree: true
              });

              if (!(participantElement as any).dataset.vexaObserverAttached) {
                (participantElement as any).dataset.vexaObserverAttached = 'true';
              }
            }

            function scanForAllGoogleParticipants() {
              const participantSelectors: string[] = selectorsTyped.participantSelectors || [];
              for (const sel of participantSelectors) {
                document.querySelectorAll(sel).forEach((el) => {
                  const elh = el as HTMLElement;
                  if (!(elh as any).dataset.vexaObserverAttached) {
                    observeGoogleParticipant(elh);
                  }
                });
              }
            }

            // Initialize speaker detection
            (window as any).logBot("Initializing Google Meet speaker detection...");
            
            try {
              const peopleSelectors: string[] = selectorsTyped.peopleButtonSelectors || [];
              for (const sel of peopleSelectors) {
                const btn = document.querySelector(sel) as HTMLElement | null;
                if (btn && isVisible(btn)) { btn.click(); break; }
              }
            } catch {}

            scanForAllGoogleParticipants();

            // Polling for speaker indicators
            const lastSpeakingById = new Map<string, boolean>();
            setInterval(() => {
              const participantSelectors: string[] = selectorsTyped.participantSelectors || [];
              const elements: HTMLElement[] = [];
              participantSelectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => elements.push(el as HTMLElement));
              });
              elements.forEach((container) => {
                const id = getGoogleParticipantId(container);
                const indicatorSpeaking = hasSpeakingIndicator(container) || inferSpeakingFromClasses(container).speaking;
                const prev = lastSpeakingById.get(id) || false;
                if (indicatorSpeaking && !prev) {
                  const name = getGoogleParticipantName(container);
                  (window as any).logBot(`[Google Poll] SPEAKER_START ${name}`);
                  currentSpeaker = name;
                  captionService.setCurrentSpeaker(name);
                  lastSpeakingById.set(id, true);
                  speakingStates.set(id, 'speaking');
                } else if (!indicatorSpeaking && prev) {
                  const name = getGoogleParticipantName(container);
                  (window as any).logBot(`[Google Poll] SPEAKER_END ${name}`);
                  lastSpeakingById.set(id, false);
                  speakingStates.set(id, 'silent');
                } else if (!lastSpeakingById.has(id)) {
                  lastSpeakingById.set(id, indicatorSpeaking);
                }
              });
            }, 500);

            // Caption segment handler - publishes to Redis
            const handleCaptionSegment = (segment: any) => {
              try {
                // Create transcription segment message in same format as Whisper
                // transcription-collector expects type "transcription" (not "transcription_segment")
                const message = {
                  type: "transcription",
                  uid: (window as any).__vexaSessionUid || browserUtils.generateBrowserUUID(),
                  token: botConfigData.token,
                  platform: botConfigData.platform,
                  meeting_id: botConfigData.nativeMeetingId,
                  segments: [{
                    text: segment.text,
                    speaker: segment.speaker,
                    start: segment.start,
                    end: segment.end,
                    completed: segment.completed
                  }]
                };

                // Send to Node.js via exposed function for Redis publishing
                if (typeof (window as any).publishCaptionToRedis === 'function') {
                  (window as any).publishCaptionToRedis(JSON.stringify(message));
                } else {
                  (window as any).logBot('[Caption] Warning: publishCaptionToRedis function not available');
                }

              } catch (error: any) {
                (window as any).logBot(`[Caption] Error handling caption segment: ${error.message}`);
              }
            };

            // Function to get current speaker for caption attribution
            const getCurrentSpeaker = () => {
              return currentSpeaker;
            };

            // Start caption monitoring
            captionService.startCaptionMonitoring(
              captionContainer,
              handleCaptionSegment,
              getCurrentSpeaker
            );

            // Setup participant counting (same as before)
            (window as any).logBot("Initializing simplified participant counting (main frame text scan)...");

            const extractParticipantsFromMain = (botName: string | undefined): string[] => {
              const participants: string[] = [];
              const mainElement = document.querySelector('main');
              if (mainElement) {
                const nameElements = mainElement.querySelectorAll('*');
                nameElements.forEach((el: Element) => {
                  const element = el as HTMLElement;
                  const text = (element.textContent || '').trim();
                  if (text && element.children.length === 0) {
                    if ((text.length > 1 && text.length < 50) || (botName && text === botName)) {
                      participants.push(text);
                    }
                  }
                });
              }
              const tooltips = document.querySelectorAll('main [role="tooltip"]');
              tooltips.forEach((el: Element) => {
                const text = (el.textContent || '').trim();
                if (text && ((text.length > 1 && text.length < 50) || (botName && text === botName))) {
                  participants.push(text);
                }
              });
              return Array.from(new Set(participants));
            };

            (window as any).getGoogleMeetActiveParticipants = () => {
              const names = extractParticipantsFromMain((botConfigData as any)?.botName);
              (window as any).logBot(`🔍 [Google Meet Participants] ${JSON.stringify(names)}`);
              return names;
            };
            (window as any).getGoogleMeetActiveParticipantsCount = () => {
              return (window as any).getGoogleMeetActiveParticipants().length;
            };
            
            // Setup meeting monitoring
            const setupGoogleMeetingMonitoring = (botConfigData: any, captionService: any, resolve: any) => {
              (window as any).logBot("Setting up Google Meet meeting monitoring...");
              
              const leaveCfg = (botConfigData && (botConfigData as any).automaticLeave) || {};
              const startupAloneTimeoutSeconds = Number(leaveCfg.startupAloneTimeoutSeconds ?? (20 * 60));
              const everyoneLeftTimeoutSeconds = Number(leaveCfg.everyoneLeftTimeoutSeconds ?? 10);
              
              let aloneTime = 0;
              let lastParticipantCount = 0;
              let speakersIdentified = false;
              let hasEverHadMultipleParticipants = false;

              const checkInterval = setInterval(() => {
                const currentParticipantCount = (window as any).getGoogleMeetActiveParticipantsCount ? (window as any).getGoogleMeetActiveParticipantsCount() : 0;
                
                if (currentParticipantCount !== lastParticipantCount) {
                  (window as any).logBot(`Participant check: Found ${currentParticipantCount} unique participants from central list.`);
                  lastParticipantCount = currentParticipantCount;
                  
                  if (currentParticipantCount > 1) {
                    hasEverHadMultipleParticipants = true;
                    speakersIdentified = true;
                    (window as any).logBot("Speakers identified - switching to post-speaker monitoring mode");
                  }
                }

                if (currentParticipantCount <= 1) {
                  aloneTime++;
                  
                  const currentTimeout = speakersIdentified ? everyoneLeftTimeoutSeconds : startupAloneTimeoutSeconds;
                  const timeoutDescription = speakersIdentified ? "post-speaker" : "startup";
                  
                  if (aloneTime >= currentTimeout) {
                    if (speakersIdentified) {
                      (window as any).logBot(`Google Meet meeting ended or bot has been alone for ${everyoneLeftTimeoutSeconds} seconds after speakers were identified. Stopping recorder...`);
                      clearInterval(checkInterval);
                      captionService.stopMonitoring();
                      reject(new Error("GOOGLE_MEET_BOT_LEFT_ALONE_TIMEOUT"));
                    } else {
                      (window as any).logBot(`Google Meet bot has been alone for ${startupAloneTimeoutSeconds/60} minutes during startup with no other participants. Stopping recorder...`);
                      clearInterval(checkInterval);
                      captionService.stopMonitoring();
                      reject(new Error("GOOGLE_MEET_BOT_STARTUP_ALONE_TIMEOUT"));
                    }
                  } else if (aloneTime > 0 && aloneTime % 10 === 0) {
                    if (speakersIdentified) {
                      (window as any).logBot(`Bot has been alone for ${aloneTime} seconds (${timeoutDescription} mode). Will leave in ${currentTimeout - aloneTime} more seconds.`);
                    } else {
                      const remainingMinutes = Math.floor((currentTimeout - aloneTime) / 60);
                      const remainingSeconds = (currentTimeout - aloneTime) % 60;
                      (window as any).logBot(`Bot has been alone for ${aloneTime} seconds during startup. Will leave in ${remainingMinutes}m ${remainingSeconds}s.`);
                    }
                  }
                } else {
                  aloneTime = 0;
                  if (hasEverHadMultipleParticipants && !speakersIdentified) {
                    speakersIdentified = true;
                    (window as any).logBot("Speakers identified - switching to post-speaker monitoring mode");
                  }
                }
              }, 1000);

              window.addEventListener("beforeunload", () => {
                (window as any).logBot("Page is unloading. Stopping recorder...");
                clearInterval(checkInterval);
                captionService.stopMonitoring();
                resolve();
              });

              document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "hidden") {
                  (window as any).logBot("Document is hidden. Stopping recorder...");
                  clearInterval(checkInterval);
                  captionService.stopMonitoring();
                  resolve();
                }
              });
            };

            setupGoogleMeetingMonitoring(botConfigData, captionService, resolve);

          }).catch((err: any) => {
            reject(err);
          });

        } catch (error: any) {
          return reject(new Error("[Google Meet Caption Error] " + error.message));
        }
      });
    },
    { 
      botConfigData: botConfig, 
      redisUrl: process.env.REDIS_STREAM_URL || 'redis://localhost:6379',
      selectors: {
        participantSelectors: googleParticipantSelectors,
        speakingClasses: googleSpeakingClassNames,
        silenceClasses: googleSilenceClassNames,
        containerSelectors: googleParticipantContainerSelectors,
        nameSelectors: googleNameSelectors,
        speakingIndicators: googleSpeakingIndicators,
        peopleButtonSelectors: googlePeopleButtonSelectors,
        captionContainerSelectors: googleCaptionContainerSelectors
      } as any
    }
  );
  
  log("[Google Meet] Caption-based recording setup complete");
}
