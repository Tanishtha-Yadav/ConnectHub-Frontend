import { Injectable, NgZone } from '@angular/core';
import { environment } from '../../environments/environment';

declare const google: any;

type GoogleCredentialCallback = (credential: string) => void;

/**
 * GoogleAuthService — Ensures google.accounts.id.initialize() is called
 * exactly ONCE per page lifecycle, avoiding the GIS singleton conflict
 * that occurs when both LoginComponent and RegisterComponent each try to
 * initialize the library with separate callbacks.
 *
 * Usage:
 *   1. Call registerCallback(cb) with your handler.
 *   2. Call renderButton(element, options) to render the sign-in button.
 *   3. Call cancelCallback() in ngOnDestroy.
 */
@Injectable({ providedIn: 'root' })
export class GoogleAuthService {

  private initialized = false;
  private activeCallback: GoogleCredentialCallback | null = null;
  private initTimer: any;
  private isProcessing = false; // Guard against double-callback

  constructor(private ngZone: NgZone) {}

  get isAvailable(): boolean {
    const id = environment.googleClientId;
    return !!id && id !== 'YOUR_GOOGLE_CLIENT_ID';
  }

  /**
   * Register a callback to receive the Google ID token.
   * Initializes GIS on first call; subsequent calls simply swap the callback.
   */
  registerCallback(callback: GoogleCredentialCallback): void {
    this.activeCallback = callback;

    if (!this.isAvailable) {
      console.warn('[GoogleAuthService] Google Client ID not configured.');
      return;
    }

    this.tryInitialize();
  }

  /**
   * Render the Google Sign-In button inside the given element.
   * Retries up to `maxRetries` times (every 300 ms) if GIS has not finished
   * loading yet — this handles the race between ngAfterViewInit and the async
   * GIS script initialisation.
   */
  renderButton(element: HTMLElement, options: Record<string, any> = {}, retries = 15): void {
    if (typeof google === 'undefined' || !google.accounts?.id) {
      if (retries > 0) {
        // GIS not ready — schedule a retry instead of silently giving up
        setTimeout(() => this.renderButton(element, options, retries - 1), 300);
      } else {
        console.warn('[GoogleAuthService] GIS not ready after max retries — giving up.');
      }
      return;
    }

    // Google's API only accepts integer pixel widths — NOT '100%' or any CSS string.
    // Read the container's actual rendered width so the button fills its parent.
    const pixelWidth = element.offsetWidth || 400;

    // Strip click_listener from options: when passed as an arrow function it gets
    // URL-encoded into the button iframe's src, causing a 403 from Google's servers.
    const { click_listener, ...safeOptions } = options;

    element.innerHTML = '';
    google.accounts.id.renderButton(element, {
      theme: 'outline',
      size: 'large',
      width: pixelWidth,
      shape: 'rectangular',
      logo_alignment: 'left',
      ...safeOptions,
    });
    console.log('[GoogleAuthService] Button rendered successfully.');
  }

  /** Trigger One Tap prompt */
  prompt(): void {
    if (typeof google === 'undefined' || !google.accounts?.id) return;
    google.accounts.id.prompt((notification: any) => {
      if (notification.isNotDisplayed?.()) {
        console.warn('[GoogleAuthService] Prompt not displayed:', notification.getNotDisplayedReason?.());
      }
      if (notification.isSkippedMoment?.()) {
        console.warn('[GoogleAuthService] Prompt skipped:', notification.getSkippedReason?.());
      }
      if (notification.isDismissedMoment?.()) {
        console.warn('[GoogleAuthService] Prompt dismissed:', notification.getDismissedReason?.());
      }
    });
  }

  /** Call in ngOnDestroy to clear the active callback */
  cancelCallback(): void {
    this.activeCallback = null;
    this.isProcessing = false; // Reset processing lock on component teardown
    if (typeof google !== 'undefined' && google.accounts?.id) {
      google.accounts.id.cancel();
    }
    if (this.initTimer) {
      clearTimeout(this.initTimer);
    }
    // Allow re-initialization when a component mounts next time
    this.initialized = false;
  }

  /** Reset the processing lock so the next Google button click works */
  resetProcessing(): void {
    this.isProcessing = false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private tryInitialize(): void {
    if (this.initialized) return;

    if (typeof google !== 'undefined' && google.accounts?.id) {
      this.doInitialize();
    } else {
      // GIS script not yet loaded — retry
      this.initTimer = setTimeout(() => this.tryInitialize(), 200);
    }
  }

  private doInitialize(): void {
    google.accounts.id.initialize({
      client_id: environment.googleClientId,
      callback: (response: any) => {
        console.log('GOOGLE RESPONSE:', response);

        if (!response?.credential) {
          console.error('[GoogleAuthService] No credential in Google response:', response);
          this.ngZone.run(() => {
            console.error('Google returned empty credential. Origin may not be authorized in Google Cloud Console.');
          });
          return;
        }

        // Guard: prevent the same token from being processed twice
        if (this.isProcessing) {
          console.warn('[GoogleAuthService] Already processing a credential — ignoring duplicate callback.');
          return;
        }
        this.isProcessing = true;

        this.ngZone.run(() => {
          if (this.activeCallback) {
            this.activeCallback(response.credential);
          }
        });
      },
      auto_select: false,
      cancel_on_tap_outside: false,
      ux_mode: 'popup',           // Explicitly use popup (avoids FedCM redirect issues)
      use_fedcm_for_prompt: false, // Disable FedCM to avoid AbortError/NetworkError in dev
    });
    this.initialized = true;
    console.log('[GoogleAuthService] GIS initialized with client_id:', environment.googleClientId);
  }
}
