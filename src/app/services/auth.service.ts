import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  AuthResponse,
  CompleteGoogleRegistrationRequest,
  GoogleRegistrationSetupResponse,
  LoginRequest,
  RegisterRequest,
  UpdateProfileRequest,
  User,
} from '../models/user.model';

/**
 * AuthService — handles login, registration, token management.
 *
 * WHY BehaviorSubject for currentUser?
 *   BehaviorSubject always holds the latest value and immediately emits
 *   it to new subscribers. This way, any component that subscribes to
 *   currentUser$ instantly gets the logged-in user without waiting.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {

  private baseUrl = environment.auth.baseUrl;

  // Holds the currently logged-in user (null if not logged in)
  private currentUserSubject = new BehaviorSubject<User | null>(this.loadStoredUser());
  currentUser$ = this.currentUserSubject.asObservable();

  constructor(private http: HttpClient) {}

  /** Register a new user account */
  register(request: RegisterRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/register`, request)
      .pipe(tap(res => this.handleAuthResponse(res)));
  }

  /** Login with email and password */
  login(request: LoginRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/login`, request)
      .pipe(tap(res => this.handleAuthResponse(res)));
  }

  /** Sign in / sign up with a Google ID token */
  googleLogin(idToken: string): Observable<AuthResponse> {
    // Uses /google endpoint (AuthServiceImpl) which:
    //   1. Verifies the token against Google's public keys (real signature check)
    //   2. Auto-creates the user if they don't exist yet
    // The request body must use `idToken` to match GoogleAuthRequest.java
    return this.http.post<AuthResponse>(`${this.baseUrl}/google`, {
      idToken: idToken
    })
      .pipe(tap(res => this.handleAuthResponse(res)));
  }

  /** Register with Google and receive setup payload (no tokens yet) */
  googleRegister(idToken: string): Observable<GoogleRegistrationSetupResponse> {
    return this.http.post<GoogleRegistrationSetupResponse>(`${this.baseUrl}/oauth2/google/register`, {
      credential: idToken
    });
  }

  /** Complete Google registration by setting username/password */
  completeGoogleRegistration(
    userId: string,
    request: CompleteGoogleRegistrationRequest
  ): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/oauth2/complete-registration/${userId}`, request)
      .pipe(tap(res => this.handleAuthResponse(res)));
  }

  /** Search users by username, full name, or email */
  searchUsers(query: string): Observable<User[]> {
    return this.http.get<User[]>(`${this.baseUrl}/search`, {
      params: { q: query }
    });
  }

  /** Refresh the JWT token */
  refreshToken(refreshToken: string): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/refresh`, {}, {
      headers: { Authorization: `Bearer ${refreshToken}` }
    }).pipe(tap(res => this.handleAuthResponse(res)));
  }

  /** Get user profile by ID */
  getUserById(userId: string): Observable<User> {
    return this.http.get<User>(`${this.baseUrl}/profile/${userId}`);
  }

  /** Get all users (Admin only) */
  getAllUsers(): Observable<User[]> {
    return this.http.get<User[]>(`${this.baseUrl}/all`);
  }

  /** Get user by username */
  getUserByUsername(username: string): Observable<User> {
    return this.http.get<User>(`${this.baseUrl}/user-by-username`, { params: { username } });
  }

  /** Update current user's profile (email is immutable) */
  updateProfile(userId: string, request: UpdateProfileRequest): Observable<User> {
    return this.http.put<User>(`${this.baseUrl}/profile`, request).pipe(
      tap((updatedUser) => {
        const currentUser = this.currentUserSubject.value;
        if (!currentUser) return;

        const mergedUser: User = {
          ...currentUser,
          ...updatedUser,
          email: currentUser.email,
        };

        localStorage.setItem('currentUser', JSON.stringify(mergedUser));
        this.currentUserSubject.next(mergedUser);
      })
    );
  }

  /** Update user status (AWAY, DND, etc.) */
  updateStatus(status: string): Observable<User> {
    return this.http.post<User>(`${this.baseUrl}/status`, null, {
      params: { status: status.toUpperCase() }
    }).pipe(
      tap((updatedUser) => {
        const currentUser = this.currentUserSubject.value;
        if (!currentUser) return;

        const mergedUser: User = {
          ...currentUser,
          status: updatedUser.status,
        };

        localStorage.setItem('currentUser', JSON.stringify(mergedUser));
        this.currentUserSubject.next(mergedUser);
      })
    );
  }

  /** Change user password */
  changePassword(userId: string, request: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/change-password`, request);
  }

  /** Logout — clear tokens and user data */
  logout(): void {
    localStorage.removeItem('authToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('currentUser');
    this.currentUserSubject.next(null);
  }

  /** Check if user is currently logged in */
  isLoggedIn(): boolean {
    return !!this.getToken();
  }

  /** Get the stored JWT access token */
  getToken(): string | null {
    return localStorage.getItem('authToken');
  }

  /** Get the current user object */
  getCurrentUser(): User | null {
    return this.currentUserSubject.value;
  }

  // ---- Private Helpers ----

  /** Store tokens and user after successful auth */
  private handleAuthResponse(response: AuthResponse): void {
    // Backend LoginResponse uses `token` field (not `accessToken`)
    localStorage.setItem('authToken', response.token);
    localStorage.setItem('refreshToken', response.refreshToken);
    localStorage.setItem('currentUser', JSON.stringify(response.user));
    this.currentUserSubject.next(response.user);
  }

  /** Load user from localStorage on app startup */
  private loadStoredUser(): User | null {
    const stored = localStorage.getItem('currentUser');
    return stored ? JSON.parse(stored) : null;
  }
}
