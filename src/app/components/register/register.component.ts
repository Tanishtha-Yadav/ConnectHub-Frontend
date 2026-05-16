import { Component, AfterViewInit, OnDestroy, NgZone, ElementRef, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { GoogleAuthService } from '../../services/google-auth.service';
import { GoogleRegistrationSetupResponse } from '../../models/user.model';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './register.component.html',
  styleUrl: './register.component.css'
})
export class RegisterComponent implements AfterViewInit, OnDestroy {
  @ViewChild('googleSignupBtn') googleSignupBtn?: ElementRef<HTMLDivElement>;

  fullName = '';
  username = '';
  email = '';
  password = '';
  confirmPassword = '';
  error = '';
  emailError = '';
  passwordError = '';
  usernameError = '';
  loading = false;
  googleLoading = false;

  get googleAvailable(): boolean {
    return this.googleAuth.isAvailable;
  }

  // Google first-time setup modal state
  showGoogleSetupModal = false;
  googleSetupUserId = '';
  googleSetupEmail = '';
  googleSetupFullName = '';
  googleSetupUsername = '';
  googleSetupPassword = '';
  googleSetupConfirmPassword = '';
  googleUsernameError = '';
  googlePasswordError = '';
  googleSetupLoading = false;

  constructor(
    private authService: AuthService,
    private googleAuth: GoogleAuthService,
    private router: Router,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef
  ) {
    if (this.authService.isLoggedIn()) {
      this.router.navigate(['/chat']);
    }
  }

  ngAfterViewInit(): void {
    // Register our callback with the singleton GIS service
    this.googleAuth.registerCallback((idToken: string) => {
      this.handleGoogleCredential(idToken);
    });

    // Wait a tick for the view to settle, then render the button
    setTimeout(() => this.renderGoogleButton(), 300);
  }

  ngOnDestroy(): void {
    this.googleAuth.cancelCallback();
  }

  private renderGoogleButton(): void {
    const element = this.googleSignupBtn?.nativeElement;
    if (!element) {
      setTimeout(() => this.renderGoogleButton(), 100);
      return;
    }

    this.googleAuth.renderButton(element, {
      text: 'signup_with',
      click_listener: () => {
        this.ngZone.run(() => {
          this.error = '';
          this.googleLoading = true;
        });
      }
    });
  }

  /** Called by GoogleAuthService after user picks an account */
  private handleGoogleCredential(idToken: string): void {
    this.ngZone.run(() => {
      this.googleLoading = true;
      this.error = '';

      this.authService.googleRegister(idToken).subscribe({
        next: (setupResponse) => {
          console.log('[Register] ✅ googleRegister next fired. Response:', JSON.stringify(setupResponse));
          this.googleLoading = false;
          this.googleAuth.resetProcessing();
          this.openGoogleSetupModal(setupResponse);
          console.log('[Register] showGoogleSetupModal set to:', this.showGoogleSetupModal);
          // Force Angular to detect the flag change in case CD missed it
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('[Register] ❌ googleRegister error fired. Status:', err.status, 'Body:', JSON.stringify(err.error));
          this.googleLoading = false;
          this.googleAuth.resetProcessing();
          const msg = err.error?.message || '';
          if (err.status === 409 || msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('already registered')) {
            alert('user already registered');
            this.error = 'An account with this email already exists.';
          } else {
            this.error = msg || 'Google sign-up failed. Please try again.';
          }
          console.log('[Register] error message set to:', this.error);
          this.cdr.detectChanges();
        }
      });
    });
  }

  private openGoogleSetupModal(setupResponse: GoogleRegistrationSetupResponse): void {
    this.googleSetupUserId = setupResponse.userId;
    this.googleSetupEmail = setupResponse.email;
    this.googleSetupFullName = setupResponse.fullName || '';
    this.googleSetupUsername = setupResponse.temporaryUsername || '';
    this.googleSetupPassword = '';
    this.googleSetupConfirmPassword = '';
    this.showGoogleSetupModal = true;
  }

  closeGoogleSetupModal(): void {
    this.showGoogleSetupModal = false;
  }

  completeGoogleSetup(): void {
    this.googleUsernameError = '';
    this.googlePasswordError = '';
    this.error = '';

    if (!this.googleSetupUsername.trim() || !this.googleSetupPassword) {
      this.error = 'Username and password are required to complete Google sign-up.';
      return;
    }

    if (this.googleSetupPassword.length < 6) {
      this.error = 'Password must be at least 6 characters.';
      return;
    }

    if (this.googleSetupPassword !== this.googleSetupConfirmPassword) {
      this.googlePasswordError = 'password didnt match';
      return;
    }

    this.googleSetupLoading = true;
    this.error = '';

    console.log('[Register] Calling completeGoogleRegistration for userId:', this.googleSetupUserId);
    this.authService.completeGoogleRegistration(this.googleSetupUserId, {
      username: this.googleSetupUsername.trim(),
      password: this.googleSetupPassword
    }).subscribe({
      next: (authResponse) => {
        console.log('[Register] ✅ completeGoogleRegistration success. Response:', JSON.stringify(authResponse));
        this.googleSetupLoading = false;
        this.showGoogleSetupModal = false;
        this.router.navigate(['/chat']);
      },
      error: (err) => {
        console.error('[Register] ❌ completeGoogleRegistration failed. Status:', err.status, 'Body:', JSON.stringify(err.error));
        this.googleSetupLoading = false;
        
        if (err.status === 409) {
          this.googleUsernameError = 'username already taken';
          this.error = 'Username already taken.';
        } else {
          this.error = err.error?.message || 'Could not complete Google setup. Please try again.';
        }
        
        this.cdr.detectChanges();
      }
    });
  }

  onRegister(): void {
    this.error = '';
    this.emailError = '';
    this.passwordError = '';
    this.usernameError = '';

    if (!this.fullName || !this.username || !this.email || !this.password) {
      this.error = 'Please fill in all fields';
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(this.email)) {
      this.emailError = 'please fill correct email';
      return;
    }

    if (this.password !== this.confirmPassword) {
      this.passwordError = 'password didnt match';
      return;
    }

    if (this.password.length < 6) {
      this.error = 'Password must be at least 6 characters';
      return;
    }

    this.loading = true;

    this.authService.register({
      fullName: this.fullName,
      username: this.username,
      email: this.email,
      password: this.password
    }).subscribe({
      next: () => {
        this.loading = false;
        this.router.navigate(['/chat']);
      },
      error: (err) => {
        this.loading = false;
        const msg = err.error?.message || '';
        if (err.status === 409) {
          if (msg.toLowerCase().includes('username')) {
            this.usernameError = 'username already taken';
          } else if (msg.toLowerCase().includes('email')) {
            alert('user already registered');
            this.emailError = 'An account with this email already exists.';
          } else {
            this.usernameError = 'username already taken';
            this.error = 'An account with this email or username already exists.';
          }
        } else {
          this.error = msg || 'Registration failed. Please try again.';
        }
        this.cdr.detectChanges();
      }
    });
  }
}
