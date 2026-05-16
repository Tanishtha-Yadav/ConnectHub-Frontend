import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Client, IMessage } from '@stomp/stompjs';
import { BehaviorSubject, Subject } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { ChatMessage } from '../models/message.model';
import SockJS from 'sockjs-client';

/**
 * WebSocketService — manages the STOMP connection over SockJS.
 *
 * CONNECTION FLOW:
 *   1. connect() creates a SockJS connection to /ws
 *   2. Sends STOMP CONNECT with JWT in the Authorization header
 *   3. On successful connect, subscribes to relevant topics
 *
 * MESSAGE FLOW:
 *   - Incoming messages arrive on subscribed topics → pushed to Subject
 *   - Outgoing messages are published via client.publish()
 *
 * WHY SockJS?
 *   Not all networks allow raw WebSocket connections. SockJS provides
 *   automatic fallback to HTTP long-polling or xhr-streaming.
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {

  private client: Client | null = null;
  private connected = new BehaviorSubject<boolean>(false);
  connected$ = this.connected.asObservable();

  // Subjects that components subscribe to for incoming events
  private messageSubject = new Subject<ChatMessage>();
  private typingSubject = new Subject<ChatMessage>();
  private readSubject = new Subject<ChatMessage>();
  private deliveredSubject = new Subject<ChatMessage>();
  private reactionSubject = new Subject<ChatMessage>();
  private notificationSubject = new Subject<any>();
  private presenceSubject = new Subject<ChatMessage>();

  messages$ = this.messageSubject.asObservable();
  typing$ = this.typingSubject.asObservable();
  reads$ = this.readSubject.asObservable();
  delivered$ = this.deliveredSubject.asObservable();
  reactions$ = this.reactionSubject.asObservable();
  notifications$ = this.notificationSubject.asObservable();
  presence$ = this.presenceSubject.asObservable();

  // Track active room subscriptions to avoid duplicates
  private activeSubscriptions = new Map<string, any>();

  // Rooms that requested subscription before WebSocket was connected —
  // drained automatically once onConnect fires.
  private pendingSubscriptions = new Set<string>();

  constructor(private authService: AuthService, private ngZone: NgZone) {}

  /**
   * Establish the STOMP connection.
   * Call this after login is successful.
   */
  connect(): void {
    const token = this.authService.getToken();
    if (!token) {
      console.warn('Cannot connect WebSocket: no auth token');
      return;
    }

    this.client = new Client({
      // Use SockJS as the WebSocket factory
      webSocketFactory: () => new SockJS(environment.websocket.url),

      beforeConnect: () => {
        const currentToken = this.authService.getToken();
        this.client!.connectHeaders = {
          Authorization: `Bearer ${currentToken}`
        };
      },

      // Auto-reconnect with backoff (5s, 10s, 20s, ...)
      reconnectDelay: 5000,

      // Heartbeats keep the connection alive
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,

      // Debug logging (disable in production)
      debug: (msg) => {
        if (!environment.production) {
          console.log('[STOMP]', msg);
        }
      },

      onConnect: () => {
        this.ngZone.run(() => {
          console.log('✅ WebSocket connected');
          this.connected.next(true);

          // Subscribe to user-specific notifications
          const user = this.authService.getCurrentUser();
          if (user) {
            this.subscribeToUserNotifications(user.userId);
          }

          // Subscribe to platform-wide public broadcast
          this.subscribeToPublicBroadcast();

          // Drain any rooms that tried to subscribe before connection was ready
          this.pendingSubscriptions.forEach(roomId => {
            console.log('[WS] Draining pending subscription for room:', roomId);
            this.subscribeToRoom(roomId);
          });
          this.pendingSubscriptions.clear();
        });
      },

      onDisconnect: () => {
        this.ngZone.run(() => {
          console.log('❌ WebSocket disconnected');
          this.connected.next(false);
        });
      },

      onStompError: (frame) => {
        console.error('STOMP error:', frame.headers['message'], frame.body);
      }
    });

    this.client.activate();
  }

  /**
   * Subscribe to a room's topic to receive messages.
   * Call this when the user opens a room.
   * If the WebSocket is not yet connected, the subscription is queued
   * and will be executed automatically once the connection is established.
   */
  subscribeToRoom(roomId: string): void {
    if (!this.client || !this.client.connected) {
      console.warn('[WS] Not connected yet — queuing subscription for room:', roomId);
      this.pendingSubscriptions.add(roomId);
      return;
    }

    // Don't subscribe twice to the same room
    if (this.activeSubscriptions.has(roomId)) {
      console.log('[WS] Already subscribed to room:', roomId);
      return;
    }

    console.log('[WS] Subscribing to room topic:', roomId);
    const subscription = this.client.subscribe(
      `/topic/room/${roomId}`,
      (message: IMessage) => {
        const payload: ChatMessage = JSON.parse(message.body);
        const eventType = this.normalizeRoomEventType(payload);
        (payload as any).eventType = eventType;
        console.log('[WS] Message received on room topic', roomId, eventType);
        // Route to the correct Subject — wrapped in NgZone so Angular's
        // change detection fires immediately (STOMP callbacks run outside zone)
        this.ngZone.run(() => {
          switch (eventType) {
            case 'TYPING':
              this.typingSubject.next(payload);
              break;
            case 'READ':
              this.readSubject.next(payload);
              break;
            case 'DELIVERED':
              this.deliveredSubject.next(payload);
              break;
            case 'REACTION':
              this.reactionSubject.next(payload);
              break;
            case 'PRESENCE_UPDATE':
              this.presenceSubject.next(payload);
              break;
            case 'PIN':
            case 'EDIT':
            case 'DELETE':
            case 'CHAT':
              this.messageSubject.next(payload);
              break;
            default:
              if (!environment.production) {
                console.warn('[WS] Unhandled room event type:', eventType, payload);
              }
          }
        });
      }
    );

    this.activeSubscriptions.set(roomId, subscription);
  }

  /** Unsubscribe from a room when the user leaves */
  unsubscribeFromRoom(roomId: string): void {
    const sub = this.activeSubscriptions.get(roomId);
    if (sub) {
      sub.unsubscribe();
      this.activeSubscriptions.delete(roomId);
    }
    // Also remove from pending queue in case it was never flushed
    this.pendingSubscriptions.delete(roomId);
  }

  /** Subscribe to private notifications for the current user */
  private subscribeToUserNotifications(userId: string): void {
    if (!this.client?.connected) return;

    this.client.subscribe(`/topic/user/${userId}`, (message: IMessage) => {
      this.ngZone.run(() => {
        const notification = JSON.parse(message.body);
        console.log('🔔 Real-time notification received:', notification);
        this.notificationSubject.next(notification);
      });
    });
  }

  /** Subscribe to public platform broadcast */
  private subscribeToPublicBroadcast(): void {
    if (!this.client?.connected) return;

    this.client.subscribe('/topic/public', (message: IMessage) => {
      this.ngZone.run(() => {
        const payload = JSON.parse(message.body);
        console.log('📢 Public message received:', payload);

        // USER_DELETED / FORCE_LOGOUT: forward as-is so the chat component handles them
        if (payload.type === 'USER_DELETED' || payload.type === 'FORCE_LOGOUT') {
          this.notificationSubject.next(payload);
          return;
        }

        // Everything else is a platform-wide broadcast notification
        this.notificationSubject.next({
          type: 'BROADCAST',
          subType: payload.subType || 'INFO',
          title: payload.title || 'Platform Announcement',
          message: payload.message,
          preview: payload.message,
          timestamp: payload.timestamp
        });
      });
    });
  }

  // =========================================================================
  // SEND methods — publish STOMP messages
  // =========================================================================

  /** Send a chat message to a room */
  sendMessage(message: ChatMessage): void {
    this.publish('/app/chat.send', {
      ...message,
      eventType: 'CHAT'
    });
  }

  /** Send a typing indicator */
  sendTyping(roomId: string, senderId: string, senderName: string): void {
    this.publish('/app/chat.typing', {
      eventType: 'TYPING',
      roomId,
      senderId,
      senderName
    });
  }

  /** Send a read receipt */
  sendReadReceipt(roomId: string, senderId: string, upToMessageId: string): void {
    this.publish('/app/chat.read', {
      eventType: 'READ',
      roomId,
      senderId,
      targetMessageId: upToMessageId
    });
  }

  /** Send a delivery receipt */
  sendDeliveryReceipt(roomId: string, senderId: string, messageId: string): void {
    this.publish('/app/chat.delivered', {
      eventType: 'DELIVERED', // Not fully typed in EventType, but we can pass it
      roomId,
      senderId,
      targetMessageId: messageId
    });
  }

  /** Send an emoji reaction */
  sendReaction(roomId: string, senderId: string, targetMessageId: string, emoji: string): void {
    this.publish('/app/chat.reaction', {
      eventType: 'REACTION',
      roomId,
      senderId,
      targetMessageId,
      reaction: emoji
    });
  }

  /** Broadcast an edit event */
  sendEdit(roomId: string, messageId: string): void {
    this.publish('/app/chat.edit', {
      eventType: 'EDIT',
      roomId,
      messageId
    });
  }

  /** Broadcast a pin event via REACTION workaround */
  sendPin(roomId: string, messageId: string, isPinned: boolean): void {
    this.publish('/app/chat.reaction', {
      eventType: 'REACTION',
      roomId,
      targetMessageId: messageId,
      reaction: isPinned ? '__PIN__' : '__UNPIN__'
    });
  }

  /** Broadcast a delete event */
  sendDelete(roomId: string, messageId: string): void {
    this.publish('/app/chat.delete', {
      eventType: 'DELETE',
      roomId,
      messageId
    });
  }

  /** Generic publish helper */
  private publish(destination: string, body: any): void {
    if (!this.client?.connected) {
      console.warn('WebSocket not connected, message not sent');
      return;
    }
    this.client.publish({
      destination,
      body: JSON.stringify(body)
    });
  }

  /** Disconnect cleanly */
  disconnect(): void {
    this.activeSubscriptions.forEach(sub => sub.unsubscribe());
    this.activeSubscriptions.clear();
    this.pendingSubscriptions.clear();
    if (this.client) {
      this.client.deactivate();
      this.client = null;
    }
    this.connected.next(false);
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  /**
   * Normalize event type so READ/DELIVERED/PRESENCE never fall through to the chat stream
   * due to casing drift or missing enum field after Redis/STOMP serialization.
   */
  private normalizeRoomEventType(payload: ChatMessage): string {
    const raw = (payload as any).eventType;
    if (raw != null && String(raw).trim() !== '') {
      return String(raw).toUpperCase();
    }
    const p: any = payload;
    if (p.isOnline !== undefined || p.lastSeenAt != null) {
      return 'PRESENCE_UPDATE';
    }
    return 'CHAT';
  }
}
