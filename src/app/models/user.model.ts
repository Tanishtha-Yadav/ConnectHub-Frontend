/** User model matching auth-service response */
export interface User {
  userId: string;
  email: string;
  username: string;
  fullName: string;
  status: string;
  role?: string;
  bio?: string;
  avatarUrl?: string;
  lastSeenAt?: string;
  statusMessage?: string;
  isActive?: boolean;
  isPrime?: boolean;
}

/** Auth response from login/register — matches backend LoginResponse DTO */
export interface AuthResponse {
  token: string;        // backend field is `token`, not `accessToken`
  refreshToken: string;
  message?: string;
  user: User;
}

/** Google OAuth registration setup response */
export interface GoogleRegistrationSetupResponse {
  userId: string;
  email: string;
  fullName: string;
  temporaryUsername: string;
  message: string;
  needsSetup: boolean;
}

/** Login request */
export interface LoginRequest {
  email: string;
  password: string;
}

/** Register request */
export interface RegisterRequest {
  email: string;
  password: string;
  username: string;
  fullName: string;
}

/** Complete Google registration setup request */
export interface CompleteGoogleRegistrationRequest {
  username: string;
  password: string;
}

/** Profile update request (email is intentionally excluded) */
export interface UpdateProfileRequest {
  username?: string;
  fullName: string;
  bio: string;
  avatarUrl?: string;
  statusMessage?: string;
}
