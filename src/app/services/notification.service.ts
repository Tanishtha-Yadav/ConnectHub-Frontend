import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface AppNotification {
  notificationId: string;
  recipientId: string;
  actorId: string;
  type: string;
  title: string;
  message: string;
  roomId?: string;
  messageId?: string;
  isRead: boolean;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private baseUrl = (environment as any).notifications?.baseUrl ?? environment.apiGatewayUrl + '/api/notifications';

  constructor(private http: HttpClient) {}

  getUnreadCount(): Observable<{ count: number }> {
    return this.http.get<{ count: number }>(`${this.baseUrl}/unread-count`);
  }

  getNotifications(): Observable<AppNotification[]> {
    return this.http.get<AppNotification[]>(`${this.baseUrl}/my`).pipe(
      map(notifs => notifs.map(n => ({ ...n, isRead: n.isRead ?? (n as any).read })))
    );
  }

  markAsRead(notificationId: string): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/${notificationId}/read`, {});
  }
}
