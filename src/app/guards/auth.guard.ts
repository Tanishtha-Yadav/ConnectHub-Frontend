import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Auth Guard — protects routes that require authentication.
 *
 * If the user is NOT logged in, they get redirected to /login.
 * This is a functional guard (Angular 15+ style, no class needed).
 */
export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isLoggedIn()) {
    return true;
  }

  // Not logged in — redirect to landing page
  router.navigate(['/']);
  return false;
};
