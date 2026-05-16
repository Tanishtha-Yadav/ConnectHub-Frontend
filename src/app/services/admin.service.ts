import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  private authUrl = `${environment.apiGatewayUrl}/api/auth/admin`;
  private roomUrl = `${environment.apiGatewayUrl}/api/rooms/admin`;
  private messageUrl = `${environment.apiGatewayUrl}/api/messages/admin`;
  private wsUrl = `${environment.apiGatewayUrl}/api/ws/admin`;

  constructor(private http: HttpClient) {}

  // Platform Analytics
  getAnalytics(): Observable<any> {
    return this.http.get(`${this.authUrl}/analytics`);
  }

  // Audit Logs
  getAuditLogs(): Observable<any[]> {
    return this.http.get<any[]>(`${this.authUrl}/audit`);
  }

  createAuditLog(log: any): Observable<any> {
    return this.http.post(`${this.authUrl}/audit`, log);
  }

  // User Management
  suspendUser(userId: string): Observable<any> {
    return this.http.put(`${this.authUrl}/users/${userId}/suspend`, {});
  }

  reactivateUser(userId: string): Observable<any> {
    return this.http.put(`${this.authUrl}/users/${userId}/reactivate`, {});
  }

  deleteUser(userId: string): Observable<any> {
    return this.http.delete(`${this.authUrl}/users/${userId}`);
  }

  // Room & Message Management
  deleteRoom(roomId: string): Observable<any> {
    return this.http.delete(`${this.roomUrl}/${roomId}`);
  }

  deleteMessage(messageId: string): Observable<any> {
    return this.http.delete(`${this.messageUrl}/${messageId}`);
  }

  // WebSocket Broadcast
  broadcastMessage(payload: any): Observable<any> {
    return this.http.post(`${this.wsUrl}/broadcast`, payload);
  }

  // Real-time connection count
  getConnectionCount(): Observable<any> {
    return this.http.get(`${this.wsUrl}/connections`);
  }
}
