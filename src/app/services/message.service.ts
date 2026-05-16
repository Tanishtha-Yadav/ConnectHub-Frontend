import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChatMessage, PagedMessages } from '../models/message.model';

/**
 * MessageService — REST API calls for message history (CRUD).
 * Real-time sending is handled by WebSocketService (STOMP).
 * This service handles fetching history, editing, deleting.
 */
@Injectable({ providedIn: 'root' })
export class MessageService {

  private baseUrl = environment.messages.baseUrl;

  constructor(private http: HttpClient) {}

  /** Get paginated messages for a room (newest first) */
  getMessages(roomId: string, page = 0, size = 20): Observable<PagedMessages> {
    const params = new HttpParams()
      .set('page', page.toString())
      .set('size', size.toString());
    return this.http.get<PagedMessages>(`${this.baseUrl}/room/${roomId}`, { params });
  }

  /** Get media gallery for a room */
  getMediaGallery(roomId: string): Observable<ChatMessage[]> {
    return this.http.get<ChatMessage[]>(`${this.baseUrl}/room/${roomId}/media`);
  }

  /** Infinite scroll: get messages before a timestamp */
  getMessagesBefore(roomId: string, before: string, page = 0, size = 20): Observable<PagedMessages> {
    const params = new HttpParams()
      .set('before', before)
      .set('page', page.toString())
      .set('size', size.toString());
    return this.http.get<PagedMessages>(`${this.baseUrl}/room/${roomId}/before`, { params });
  }

  /** Send a message via REST (persists to DB; also call WebSocket for real-time) */
  sendMessage(message: Partial<ChatMessage>): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.baseUrl}/send`, message);
  }

  /** Edit a message */
  editMessage(messageId: string, requesterId: string, newContent: string): Observable<ChatMessage> {
    const params = new HttpParams().set('requesterId', requesterId);
    return this.http.put<ChatMessage>(
      `${this.baseUrl}/${messageId}/edit`,
      { newContent },
      { params }
    );
  }

  /** Delete a message (soft delete) */
  deleteMessage(messageId: string, requesterId: string): Observable<ChatMessage> {
    const params = new HttpParams().set('requesterId', requesterId);
    return this.http.delete<ChatMessage>(`${this.baseUrl}/${messageId}`, { params });
  }

  /** React to a message */
  reactToMessage(messageId: string, emoji: string): Observable<ChatMessage> {
    const params = new HttpParams().set('emoji', emoji);
    return this.http.put<ChatMessage>(`${this.baseUrl}/${messageId}/react`, {}, { params });
  }

  /** Search messages in a room */
  searchMessages(roomId: string, keyword: string, page = 0, size = 20): Observable<PagedMessages> {
    const params = new HttpParams()
      .set('keyword', keyword)
      .set('page', page.toString())
      .set('size', size.toString());
    return this.http.get<PagedMessages>(`${this.baseUrl}/room/${roomId}/search`, { params });
  }

  /** Pin or unpin a message */
  pinMessage(messageId: string, isPinned: boolean): Observable<ChatMessage> {
    const params = new HttpParams().set('isPinned', isPinned.toString());
    return this.http.put<ChatMessage>(`${this.baseUrl}/pin/${messageId}`, {}, { params });
  }

  /** Clear all messages in a room (Admin/Owner) */
  clearRoomHistory(roomId: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/room/${roomId}/history`);
  }
}
