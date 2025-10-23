import { Page } from "playwright";
import { log } from "../../utils";
import { googleCaptionButtonSelectors } from "./selectors";

/**
 * Language codes supported by Google Meet captions
 * Common languages - expand as needed
 */
export const GOOGLE_MEET_LANGUAGES: Record<string, string> = {
  'en': 'English',
  'en-US': 'English',
  'es': 'Spanish',
  'es-ES': 'Spanish',
  'fr': 'French',
  'fr-FR': 'French',
  'de': 'German',
  'de-DE': 'German',
  'it': 'Italian',
  'it-IT': 'Italian',
  'pt': 'Portuguese',
  'pt-PT': 'Portuguese',
  'pt-BR': 'Portuguese (Brazil)',
  'ja': 'Japanese',
  'ja-JP': 'Japanese',
  'ko': 'Korean',
  'ko-KR': 'Korean',
  'zh': 'Chinese',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  'ru': 'Russian',
  'ru-RU': 'Russian',
  'ar': 'Arabic',
  'ar-SA': 'Arabic',
  'hi': 'Hindi',
  'hi-IN': 'Hindi',
  'nl': 'Dutch',
  'nl-NL': 'Dutch',
  'pl': 'Polish',
  'pl-PL': 'Polish',
  'tr': 'Turkish',
  'tr-TR': 'Turkish',
  'sv': 'Swedish',
  'sv-SE': 'Swedish',
  'da': 'Danish',
  'da-DK': 'Danish',
  'no': 'Norwegian',
  'nb': 'Norwegian',
  'fi': 'Finnish',
  'fi-FI': 'Finnish',
};

/**
 * Select caption language in Google Meet
 */
export async function selectGoogleMeetCaptionLanguage(
  page: Page, 
  languageCode: string
): Promise<boolean> {
  log(`[Captions] Attempting to set caption language to: ${languageCode}`);
  
  try {
    // Normalize language code
    const normalizedCode = languageCode.toLowerCase();
    const languageName = GOOGLE_MEET_LANGUAGES[normalizedCode];
    
    if (!languageName) {
      log(`[Captions] Warning: Language code "${languageCode}" not recognized. Available codes: ${Object.keys(GOOGLE_MEET_LANGUAGES).join(', ')}`);
      log(`[Captions] Will try to use it anyway...`);
    }
    
    // Strategy: Find the caption settings button/menu
    // Google Meet may have:
    // 1. A settings icon/button near the captions
    // 2. A dropdown directly on the caption button
    // 3. Access via the three-dot "More options" menu
    
    log("[Captions] Searching for caption settings button...");
    
    // Try to find and click caption settings
    const settingsFound = await page.evaluate((targetLanguage: string) => {
      // Look for caption settings button (gear icon, dropdown, etc.)
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      
      for (const btn of buttons) {
        const element = btn as HTMLElement;
        const ariaLabel = element.getAttribute('aria-label') || '';
        const text = element.textContent || '';
        
        // Look for settings/options related to captions
        if (
          ariaLabel.toLowerCase().includes('caption') && 
          (ariaLabel.toLowerCase().includes('settings') || 
           ariaLabel.toLowerCase().includes('options') ||
           ariaLabel.toLowerCase().includes('language'))
        ) {
          console.log('[Vexa] Found caption settings button:', ariaLabel);
          element.click();
          return { found: true, method: 'settings_button' };
        }
      }
      
      // Try to find a dropdown menu that might be open
      const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]'));
      for (const menu of menus) {
        const items = menu.querySelectorAll('[role="menuitem"], [role="option"]');
        for (const item of items) {
          const itemText = (item.textContent || '').trim();
          // Look for language options
          if (itemText.includes(targetLanguage) || itemText.toLowerCase().includes('language')) {
            console.log('[Vexa] Found language menu item:', itemText);
            (item as HTMLElement).click();
            return { found: true, method: 'menu_item' };
          }
        }
      }
      
      return { found: false };
    }, languageName || languageCode);
    
    if (settingsFound.found) {
      log(`[Captions] Found caption settings using method: ${settingsFound.method}`);
      await page.waitForTimeout(1000);
      
      // Now try to select the language from the menu/dropdown
      const languageSelected = await page.evaluate((targetLanguage: string) => {
        // Look for language options in any visible menus
        const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], .language-option, [class*="language"]'));
        
        for (const element of allElements) {
          const el = element as HTMLElement;
          const text = (el.textContent || '').trim();
          
          if (text.toLowerCase().includes(targetLanguage.toLowerCase())) {
            console.log('[Vexa] Clicking language option:', text);
            el.click();
            return true;
          }
        }
        
        return false;
      }, languageName || languageCode);
      
      if (languageSelected) {
        log(`[Captions] Successfully selected language: ${languageName || languageCode}`);
        await page.waitForTimeout(1000);
        return true;
      }
    }
    
    // Alternative approach: Try the three-dot menu
    log("[Captions] Trying three-dot menu approach...");
    const moreOptionsClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      
      for (const btn of buttons) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        
        if (ariaLabel.toLowerCase().includes('more options') || 
            ariaLabel.toLowerCase().includes('more actions')) {
          console.log('[Vexa] Found More options button');
          btn.click();
          return true;
        }
      }
      
      return false;
    });
    
    if (moreOptionsClicked) {
      log("[Captions] Clicked More options, waiting for menu...");
      await page.waitForTimeout(1000);
      
      // Look for "Settings" or "Captions" in the menu
      const settingsClicked = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
        
        for (const item of items) {
          const text = (item.textContent || '').trim().toLowerCase();
          
          if (text.includes('caption') || text.includes('settings')) {
            console.log('[Vexa] Clicking menu item:', text);
            (item as HTMLElement).click();
            return true;
          }
        }
        
        return false;
      });
      
      if (settingsClicked) {
        log("[Captions] Opened caption settings from menu");
        await page.waitForTimeout(1000);
        
        // Try to select language again
        const finalLanguageSelect = await page.evaluate((targetLanguage: string) => {
          const elements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], select option, [class*="language"]'));
          
          for (const element of elements) {
            const el = element as HTMLElement;
            const text = (el.textContent || '').trim();
            
            if (text.toLowerCase().includes(targetLanguage.toLowerCase())) {
              console.log('[Vexa] Selecting language:', text);
              el.click();
              return true;
            }
          }
          
          return false;
        }, languageName || languageCode);
        
        if (finalLanguageSelect) {
          log(`[Captions] Successfully selected language: ${languageName || languageCode}`);
          return true;
        }
      }
    }
    
    log(`[Captions] Could not find language selector for: ${languageCode}`);
    log(`[Captions] Google Meet may be using default language or language selection may not be available`);
    return false;
    
  } catch (error: any) {
    log(`[Captions] Error selecting language: ${error.message}`);
    return false;
  }
}

/**
 * Enable Google Meet captions programmatically, optionally selecting a language
 */
export async function enableGoogleMeetCaptions(page: Page, languageCode?: string): Promise<boolean> {
  log("[Captions] Attempting to enable Google Meet captions...");

  try {
    // Wait a bit for the meeting UI to fully load
    await page.waitForTimeout(3000);
    log("[Captions] Waited for UI to load, now searching for caption button...");
    
    // UNIVERSAL APPROACH: Find button by icon text using JavaScript
    log("[Captions] Searching for caption button using JavaScript (icon-based)...");
    
    const buttonFound = await page.evaluate(() => {
      // Find all buttons
      const allButtons = Array.from(document.querySelectorAll('button'));
      
      for (const btn of allButtons) {
        // Check if button contains caption icon
        const icons = btn.querySelectorAll('i');
        for (const icon of icons) {
          const iconText = icon.textContent?.trim();
          // Look for caption icon text
          if (iconText === 'closed_caption' || iconText === 'closed_caption_off') {
            console.log('[Vexa] Found caption button by icon:', iconText);
            
            // Check aria-label to see if already enabled
            const ariaLabel = btn.getAttribute('aria-label') || '';
            console.log('[Vexa] Button aria-label:', ariaLabel);
            
            // Check if captions are already ON (button says "turn off" or similar)
            const offPatterns = ['turn off', 'Turn off', 'Wyłącz', 'wyłącz', 'disable', 'Disable', 'Desactivar', 'désactiver'];
            const isAlreadyOn = offPatterns.some(pattern => ariaLabel.includes(pattern));
            
            if (isAlreadyOn) {
              console.log('[Vexa] Captions already enabled');
              return { found: true, alreadyOn: true };
            }
            
            // Click the button to enable captions
            console.log('[Vexa] Clicking caption button...');
            btn.click();
            console.log('[Vexa] Caption button clicked');
            return { found: true, alreadyOn: false, clicked: true };
          }
        }
      }
      
      console.error('[Vexa] No caption button found by icon');
      return { found: false };
    });
    
    if (buttonFound.found) {
      if (buttonFound.alreadyOn) {
        log("[Captions] Captions are already enabled (detected by JavaScript)");
        return true;
      }
      
      if (buttonFound.clicked) {
        log("[Captions] Caption button clicked successfully via JavaScript");
        await page.waitForTimeout(3000); // Wait for captions to appear
        
        // If language is specified, try to select it
        if (languageCode) {
          await selectGoogleMeetCaptionLanguage(page, languageCode);
        }
        
        return true;
      }
    }
    
    // FALLBACK: Try selector-based approach if JavaScript fails
    log("[Captions] JavaScript search failed, trying selector-based approach...");
    
    for (const selector of googleCaptionButtonSelectors) {
      try {
        const button = await page.$(selector);
        
        if (button) {
          log(`[Captions] Found button element with selector: ${selector}, checking visibility...`);
          const isVisible = await button.isVisible();
          log(`[Captions] Button visible: ${isVisible}`);
          
          if (isVisible) {
            const ariaLabel = await button.getAttribute('aria-label');
            const ariaPressed = await button.getAttribute('aria-pressed');
            
            log(`[Captions] Button aria-label: "${ariaLabel}"`);
            
            const offPatterns = ['turn off', 'Turn off', 'Wyłącz', 'wyłącz', 'disable', 'Disable'];
            const isAlreadyOn = ariaPressed === 'true' || offPatterns.some(pattern => ariaLabel?.includes(pattern));
            
            if (isAlreadyOn) {
              log("[Captions] Captions are already enabled");
              
              // If language is specified, try to select it
              if (languageCode) {
                await selectGoogleMeetCaptionLanguage(page, languageCode);
              }
              
              return true;
            }
            
            // Click using JavaScript
            await page.evaluate((sel: string) => {
              const btn = document.querySelector(sel) as HTMLElement;
              if (btn) btn.click();
            }, selector);
            
            log("[Captions] Caption button clicked");
            await page.waitForTimeout(3000);
            
            // If language is specified, try to select it
            if (languageCode) {
              await selectGoogleMeetCaptionLanguage(page, languageCode);
            }
            
            return true;
          }
        }
      } catch (e: any) {
        log(`[Captions] Selector ${selector} failed: ${e.message}`);
        continue;
      }
    }

    // If we get here, no caption button was found
    log("[Captions] Warning: Could not find caption button. Captions may not be available in this meeting.");
    return false;

  } catch (error: any) {
    log(`[Captions] Error enabling captions: ${error.message}`);
    return false;
  }
}

/**
 * Wait for caption container to appear after enabling captions
 */
export async function waitForCaptionContainer(
  page: Page, 
  containerSelectors: string[], 
  timeout: number = 15000
): Promise<boolean> {
  log("[Captions] Waiting for caption container to appear...");
  
  try {
    // Try to wait for any of the container selectors
    for (const selector of containerSelectors) {
      try {
        // Use 'attached' state instead of 'visible' - caption container exists in DOM but may not be "visible"
        await page.waitForSelector(selector, { 
          timeout: timeout / containerSelectors.length,
          state: 'attached'  // Just wait for element to be in DOM, not strictly visible
        });
        log(`[Captions] Caption container found with selector: ${selector}`);
        
        // Double-check the element actually exists
        const element = await page.$(selector);
        if (element) {
          log(`[Captions] Verified caption container exists in DOM`);
          return true;
        }
      } catch (e: any) {
        // This selector didn't appear, try next
        log(`[Captions] Selector "${selector}" not found: ${e.message}`);
        continue;
      }
    }
    
    log("[Captions] Warning: Caption container did not appear within timeout");
    log("[Captions] Tried these selectors:");
    containerSelectors.slice(0, 10).forEach((sel, idx) => {
      log(`[Captions]   ${idx + 1}. ${sel}`);
    });
    return false;
    
  } catch (error: any) {
    log(`[Captions] Error waiting for caption container: ${error.message}`);
    return false;
  }
}

