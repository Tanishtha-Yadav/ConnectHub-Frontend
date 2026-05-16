import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class PresenceService {
  private baseUrl = environment.apiGatewayUrl + '/api/presence';

  constructor(private http: HttpClient) {}

  /** Set custom online status (online, away, dnd, invisible) */
  setStatus(userId: string, status: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/status/${userId}`, null, {
      params: { status }
    });
  }

  /** Set user online */
  setOnline(userId: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/online/${userId}`, null);
  }

  /** Mark user offline and persist last-seen (WebSocket disconnect + tab close) */
  setOffline(userId: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/offline/${userId}`, null);
  }

  /** Get user's online status string and last seen timestamp */
  getStatus(userId: string): Observable<{ status: string, lastSeen?: string }> {
    return this.http.get<{ status: string, lastSeen?: string }>(`${this.baseUrl}/${userId}/status`);
  }

  /** Check if user is online (boolean) */
  isOnline(userId: string): Observable<{ online: boolean }> {
    return this.http.get<{ online: boolean }>(`${this.baseUrl}/isOnline/${userId}`);
  }

  /** Get user's last-seen timestamp only (fallback endpoint) */
  getLastSeen(userId: string): Observable<{ lastSeen?: string }> {
    return this.http.get<{ lastSeen?: string }>(`${this.baseUrl}/last-seen/${userId}`);
  }

  /** Get all online users */
  getOnlineUsers(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/online-users`);
  }
}
