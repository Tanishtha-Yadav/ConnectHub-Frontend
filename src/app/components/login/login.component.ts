import { Component, AfterViewInit, OnDestroy, NgZone, ElementRef, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { GoogleAuthService } from '../../services/google-auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent implements AfterViewInit, OnDestroy {
  @ViewChild('googleSigninBtn') googleSigninBtn?: ElementRef<HTMLDivElement>;

  email = '';
  password = '';
  error = '';
  emailError = '';
  loading = false;
  googleLoading = false;

  get googleAvailable(): boolean {
    return this.googleAuth.isAvailable;
  }

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
    const element = this.googleSigninBtn?.nativeElement;
    if (!element) {
      setTimeout(() => this.renderGoogleButton(), 100);
      return;
    }

    this.googleAuth.renderButton(element, {
      text: 'signin_with',
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

      this.authService.googleLogin(idToken).subscribe({
        next: () => {
          this.googleLoading = false;
          this.googleAuth.resetProcessing();
          this.router.navigate(['/chat']);
        },
        error: (err) => {
          this.googleLoading = false;
          this.googleAuth.resetProcessing();
          const msg: string = err.error?.message || '';
          const status: number = err.status;

          if (msg.toLowerCase().includes('complete google registration') ||
              msg.toLowerCase().includes('please complete')) {
            // Partial Google registration — redirect to finish setup
            this.router.navigate(['/register']);
          } else if (msg.toLowerCase().includes('invalid google') ||
                     msg.toLowerCase().includes('invalid token')) {
            this.error = 'Google sign-in failed. Please try again.';
            this.cdr.detectChanges();
          } else {
            // Assume any other Google login failure (401, 404, bad credentials) means user not registered
            this.error = msg || 'Login failed: Google account not registered. Please register first.';
            alert('user not registered');
            this.cdr.detectChanges();
          }
        }
      });
    });
  }

  onLogin(): void {
    this.error = '';
    this.emailError = '';

    if (!this.email || !this.password) {
      this.error = 'Please fill in all fields';
      return;
    }

    this.loading = true;

    this.authService.login({ email: this.email, password: this.password }).subscribe({
      next: () => {
        this.loading = false;
        this.router.navigate(['/chat']);
      },
      error: (err) => {
        this.loading = false;
        const msg = err.error?.message || '';
        
        if (err.status === 404 || msg.toLowerCase().includes('not registered') || msg.toLowerCase().includes('not found')) {
          this.emailError = 'user not registered';
        } else {
          this.error = msg || 'Login failed. Please check your credentials.';
        }
        
        this.cdr.detectChanges();
      }
    });
  }
}
