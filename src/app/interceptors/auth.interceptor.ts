import { HttpInterceptorFn, HttpErrorResponse, HttpRequest, HttpHandlerFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, throwError, catchError, switchMap, filter, take, Observable } from 'rxjs';
import { AuthService } from '../services/auth.service';

// Global state for interceptor to handle concurrent 401s gracefully
let isRefreshing = false;
let refreshTokenSubject = new BehaviorSubject<any>(null);

// Endpoints that should NEVER trigger a session logout on error
const PUBLIC_ENDPOINTS = ['/login', '/refresh', '/register', '/oauth2', '/validate'];

/**
 * HTTP Interceptor — automatically attaches the JWT token
 * and handles transparent token refreshes on 401 errors.
 *
 * RESILIENT DESIGN:
 * - Only forces logout if the auth/token-validation service itself says 401.
 * - Transient 401s from restarting microservices (message-service, room-service, etc.)
 *   are passed through without killing the user session.
 * - 503 Service Unavailable (from Docker restarts) is never treated as an auth failure.
 */
export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  let authReq = req;
  const token = localStorage.getItem('authToken');

  if (token && !req.headers.has('Authorization')) {
    authReq = req.clone({
      setHeaders: { Authorization: `Bearer ${token}` }
    });
  }

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      const isPublicEndpoint = PUBLIC_ENDPOINTS.some(ep => req.url.includes(ep));

      // Only attempt refresh/logout on 401 from protected endpoints
      if (error.status === 401 && !isPublicEndpoint) {
        // Only redirect to login if the gateway/auth-service returns 401
        // (meaning the token itself is definitively invalid/expired)
        // If it's a microservice internal 401 (e.g. room-service, message-service)
        // just pass the error through — let the component handle it.
        const isGatewayAuth = req.url.includes(`:8080`) || req.url.includes('api-gateway');
        if (isGatewayAuth || isDefinitiveAuthFailure(req.url)) {
          return handle401Error(authReq, next, authService, router);
        }
      }

      // For 503 (service unavailable during restart), 502, 504 — never logout
      // Just pass the error to the component
      return throwError(() => error);
    })
  );
};

/**
 * Determines if this URL is an auth-critical endpoint where a 401
 * definitively means the token is invalid.
 */
function isDefinitiveAuthFailure(url: string): boolean {
  // Only treat 401 as "must re-authenticate" for the gateway port or auth paths
  return url.includes('8080') || url.includes('/api/auth/');
}

function handle401Error(request: HttpRequest<unknown>, next: HttpHandlerFn, authService: AuthService, router: Router): Observable<any> {
  if (!isRefreshing) {
    isRefreshing = true;
    refreshTokenSubject.next(null);

    const refreshToken = localStorage.getItem('refreshToken');

    if (refreshToken) {
      return authService.refreshToken(refreshToken).pipe(
        switchMap((res: any) => {
          isRefreshing = false;
          refreshTokenSubject.next(res.token);
          return next(request.clone({
            setHeaders: { Authorization: `Bearer ${res.token}` }
          }));
        }),
        catchError((err) => {
          isRefreshing = false;
          // Only truly logout if refresh endpoint itself returns 401/403/404
          // (meaning both access AND refresh tokens are expired/invalid, or user deleted)
          if (err.status === 401 || err.status === 403 || err.status === 404) {
            authService.logout();
            router.navigate(['/login']);
          }
          // For network errors or 503 during backend restart — don't logout!
          return throwError(() => err);
        })
      );
    } else {
      isRefreshing = false;
      // No refresh token at all — this is a genuine unauthenticated session
      authService.logout();
      router.navigate(['/login']);
      return throwError(() => new Error('No refresh token available'));
    }
  } else {
    return refreshTokenSubject.pipe(
      filter(token => token !== null),
      take(1),
      switchMap((jwt) => {
        return next(request.clone({
          setHeaders: { Authorization: `Bearer ${jwt}` }
        }));
      })
    );
  }
}

