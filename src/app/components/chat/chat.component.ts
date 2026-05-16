declare var Razorpay: any;
import { PaymentService } from '../../services/payment.service';
import { Component, OnInit, OnDestroy, ViewChild, ElementRef, NgZone, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';

import { AuthService } from '../../services/auth.service';
import { RoomService } from '../../services/room.service';
import { MessageService } from '../../services/message.service';
import { WebSocketService } from '../../services/websocket.service';
import { MediaService } from '../../services/media.service';
import { NotificationService } from '../../services/notification.service';
import { PresenceService } from '../../services/presence.service';
import { forkJoin } from 'rxjs';
import { User } from '../../models/user.model';
import { Room, RoomMember } from '../../models/room.model';
import { ChatMessage } from '../../models/message.model';
import { AppNotification } from '../../services/notification.service';
import { environment } from '../../../environments/environment';

/**
 * ChatComponent — the main dashboard.
 * Layout: Sidebar (room list) | Message Area (messages + input)
 *
 * LIFECYCLE:
 * 1. OnInit: load user rooms, connect WebSocket
 * 2. Select a room → load message history + subscribe to STOMP topic
 * 3. Send message → publish via WebSocket (real-time)
 * 4. OnDestroy: disconnect WebSocket
 */
@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('messageContainer') messageContainer!: ElementRef;
  @ViewChild('messageInput') messageInput!: ElementRef;

  currentUser: User | null = null;
  rooms: Room[] = [];
  selectedRoom: Room | null = null;
  messages: ChatMessage[] = [];
  newMessage = '';
  typingUsers: Map<string, string> = new Map(); // senderId → senderName

  // Create room form
  showCreateRoom = false;
  newRoomName = '';
  newRoomDescription = '';
  newRoomType: 'GROUP' | 'DIRECT' | 'CHANNEL' = 'GROUP';
  newRoomMaxMembers: number | null = null;
  newRoomMembers: string[] = []; // selected member IDs
  selectedMembersForNewRoom: User[] = []; // selected member objects for display
  newRoomMemberSearch = '';
  newRoomMemberSearchResults: User[] = [];
  newRoomMemberSearchLoading = false;

  // Tabs
  activeTab: 'chats' | 'rooms' = 'chats';
  roomSearchTerm = '';

  get chatRooms(): Room[] {
    return this.rooms.filter(r => r.type === 'DIRECT');
  }

  get groupRooms(): Room[] {
    return this.rooms.filter(r => r.type !== 'DIRECT');
  }

  get filteredGroupRooms(): Room[] {
    if (!this.roomSearchTerm) return this.groupRooms;
    const term = this.roomSearchTerm.toLowerCase();
    return this.groupRooms.filter(r => r.name.toLowerCase().includes(term));
  }

  // Loading states
  loadingRooms = true;
  loadingMessages = false;
  sendingMessage = false;
  uploadingFile = false;

  // Notifications
  unreadNotificationCount = 0;
  showNotifPanel = false;
  notifications: AppNotification[] = [];
  notifLoading = false;

  // User search
  userSearchTerm = '';
  userSearchResults: User[] = [];
  userSearchLoading = false;
  userSearchError = '';
  dmLoading = false; // loading state while opening DM

  // Profile editor
  showProfileModal = false;
  profileUsername = '';
  profileFullName = '';
  profileBio = '';
  profileAvatarUrl = '';
  profileStatusMessage = '';
  profileOnlineStatus = 'online';
  
  // Password change
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  
  profileSaving = false;

  // Pinned message carousel index
  pinnedMessageIndex = 0;

  // Room Info Modal
  showRoomInfoModal = false;
  roomMembersWithDetails: (RoomMember & { user?: User, onlineStatus?: string, status?: string, lastSeenAt?: string })[] = [];
  roomInfoLoading = false;
  addMemberSearchTerm = '';
  addMemberSearchResults: User[] = [];

  // Room Settings Modal
  showRoomSettingsModal = false;
  roomSettingsName = '';
  roomSettingsDesc = '';
  roomSettingsAvatar = '';
  roomSettingsMaxMembers: number | null = null;
  roomSettingsSaving = false;

  // Join Room by Invite Modal
  showJoinRoomModal = false;
  joinToken = '';
  joiningRoom = false;

  // Media Gallery
  showGalleryModal = false;
  galleryMessages: ChatMessage[] = [];
  galleryLoading = false;

  // Unified Details Modal
  showDetailsModal = false;
  detailsType: 'USER' | 'ROOM' = 'USER';
  detailsUser: User | null = null;
  detailsRoom: Room | null = null;

  // Prime Upgrade Modal
  showPrimeModal = false;
  selectedPrimePlan: 'MONTHLY' | 'YEARLY' = 'MONTHLY';
  upgradingPrime = false;

  // Cache for async-fetched file sizes (for old messages without JSON content)
  private fileSizeCache = new Map<string, string>();
  private fileSizeFetching = new Set<string>(); // guard against duplicate in-flight fetches

  private subscriptions: Subscription[] = [];
  private typingTimeout: any;
  private roomRefreshInterval: any;
  private notifPollInterval: any;
  private broadcastDismissTimer: any;

  // Platform broadcast banner (shown when admin sends system-wide announcement)
  activeBroadcast: { title: string; message: string; subType: string } | null = null;

  // Persist delivery/read state across room switching & REST reloads.
  // Keyed by messageId; value is the highest known status.
  private deliveryStatusCache = new Map<string, 'SENT' | 'DELIVERED' | 'READ'>();

  private statusRank(s?: string): number {
    switch (s) {
      case 'READ': return 3;
      case 'DELIVERED': return 2;
      case 'SENT': return 1;
      default: return 0;
    }
  }

  private cacheStatus(messageId: string | undefined, status: any): void {
    if (!messageId) return;
    const next = status as 'SENT' | 'DELIVERED' | 'READ' | undefined;
    if (!next) return;
    const prev = this.deliveryStatusCache.get(messageId);
    if (!prev || this.statusRank(next) > this.statusRank(prev)) {
      this.deliveryStatusCache.set(messageId, next);
      this.persistDeliveryCache();
    }
  }

  private deliveryCacheStorageKey(): string {
    return `connecthub:v1:delivery:${this.currentUser?.userId || 'anon'}`;
  }

  private loadDeliveryCache(): void {
    try {
      const raw = sessionStorage.getItem(this.deliveryCacheStorageKey());
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, 'SENT' | 'DELIVERED' | 'READ'>;
      this.deliveryStatusCache = new Map(Object.entries(obj));
    } catch {
      /* ignore */
    }
  }

  private persistDeliveryCache(): void {
    try {
      const obj = Object.fromEntries(this.deliveryStatusCache);
      sessionStorage.setItem(this.deliveryCacheStorageKey(), JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  private readonly beforeUnloadHandler = () => this.flushPresenceOfflineKeepalive();

  /** Browser close / refresh: ensure last-seen is written even if STOMP disconnect races. */
  private flushPresenceOfflineKeepalive(): void {
    const userId = this.currentUser?.userId;
    const token = localStorage.getItem('authToken');
    if (!userId || !token) return;
    const url = `${environment.apiGatewayUrl}/api/presence/offline/${userId}`;
    try {
      fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true
      });
    } catch {
      /* ignore */
    }
  }

  private getCachedOrIncomingStatus(messageId: string | undefined, incoming?: any): any {
    if (!messageId) return incoming;
    const cached = this.deliveryStatusCache.get(messageId);
    if (!cached) return incoming;
    return this.statusRank(cached) >= this.statusRank(incoming) ? cached : incoming;
  }

  // Mention system
  showMentionPopup = false;
  mentionSearchTerm = '';
  mentionSuggestions: User[] = [];
  currentRoomUsers: User[] = [];

  // Emoji picker
  showEmojiPicker = false;
  emojis = ['😀','😂','❤️','👍','🎉','🔥','😍','🤔','👋','✅','💬','⭐'];

  // Message Actions
  replyingToMessage: ChatMessage | null = null;
  editingMessage: ChatMessage | null = null;
  showReactionPickerFor: string | null | undefined = null;
  
  // Pagination
  loadingMoreMessages = false;
  hasMoreMessages = true;
  oldestMessageDate: string | null = null;
  
  // Search
  showMessageSearch = false;
  messageSearchTerm = '';
  isSearching = false;

  // Downloads tracking
  downloadedFiles = new Set<string>();
  downloadingFiles = new Set<string>();

  // Mobile responsive: sidebar drawer state
  mobileSidebarOpen = false;

  constructor(
    private authService: AuthService,
    private roomService: RoomService,
    private messageService: MessageService,
    private wsService: WebSocketService,
    private mediaService: MediaService,
    private notifService: NotificationService,
    private presenceService: PresenceService,
    private paymentService: PaymentService,
    private router: Router,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.currentUser = this.authService.getCurrentUser();
    if (!this.currentUser) {
      this.router.navigate(['/login']);
      return;
    }
    // Sanitize current user's avatarUrl at startup
    this.sanitizeUser(this.currentUser);

    // Step 1: Load user's rooms
    this.loadRooms();

    this.profileFullName = this.currentUser.fullName || '';
    this.profileBio = this.currentUser.bio || '';
    this.profileAvatarUrl = this.currentUser.avatarUrl || '';

    this.loadDeliveryCache();
    window.addEventListener('beforeunload', this.beforeUnloadHandler);

    const savedDownloads = localStorage.getItem(`connecthub:v1:downloads:${this.currentUser.userId}`);
    if (savedDownloads) {
      try {
        const arr = JSON.parse(savedDownloads);
        this.downloadedFiles = new Set<string>(arr);
      } catch (e) {}
    }

    // Step 2: Connect WebSocket
    this.wsService.connect();

    // Step 3: Subscribe to incoming WebSocket events
    this.subscriptions.push(
      this.wsService.messages$.subscribe(msg => this.onMessageReceived(msg)),
      this.wsService.typing$.subscribe(msg => this.onTypingReceived(msg)),
      this.wsService.reads$.subscribe(msg => this.onReadReceived(msg)),
      this.wsService.delivered$.subscribe(msg => this.onDeliveredReceived(msg)),
      this.wsService.reactions$.subscribe(msg => this.onReactionReceived(msg)),
      this.wsService.presence$.subscribe(msg => this.onPresenceReceived(msg)),
      this.wsService.notifications$.subscribe(notification => {
        if (notification?.type === 'FORCE_LOGOUT') {
          this.authService.logout();
          this.router.navigate(['/login']);
          alert('Your account has been deleted or your session was terminated by an administrator.');
          return;
        }
        // USER_DELETED: reload rooms so DMs with the deleted user disappear for all online clients
        if (notification?.type === 'USER_DELETED') {
          const deletedUserId: string = notification.userId;
          this.ngZone.run(() => {
            // If the currently open room is a DM with the deleted user, close it
            if (this.selectedRoom?.type === 'DIRECT') {
              const memberIds = this.selectedRoom.members?.map((m: any) => m.userId) ?? [];
              if (memberIds.includes(deletedUserId)) {
                this.selectedRoom = null;
              }
            }
            // Reload full room list from server (backend has already removed DM rooms)
            this.loadRooms();
            this.cdr.detectChanges();
          });
          return;
        }
        // If it's a platform-wide broadcast, show the banner
        if (notification?.type === 'BROADCAST') {
          this.showBroadcastBanner(notification);
        } else {
          // Always refresh unread count for real notifications
          this.loadUnreadNotifications();
        }
      })
    );

    // Step 4: Load unread notifications badge
    this.loadUnreadNotifications();

    // Step 5: Periodically refresh room list to catch new rooms / updated unread counts
    this.startRoomRefreshInterval();

    // Step 6: Poll notification count every 15 seconds
    this.notifPollInterval = setInterval(() => this.loadUnreadNotifications(), 15000);
  }

  startRoomRefreshInterval(): void {
    // Refresh room list every 5 seconds to detect new rooms
    this.roomRefreshInterval = setInterval(() => {
      this.refreshRooms();
    }, 5000);
  }

  refreshRooms(): void {
    this.roomService.getMyRooms().subscribe({
      next: (rooms) => {
        const list: Room[] = Array.isArray(rooms) ? rooms : (rooms as any).content ?? [];
        this.ngZone.run(() => {
          let changed = false;

          // Remove deleted rooms
          const newRoomIds = new Set(list.map(r => r.roomId));
          const originalLength = this.rooms.length;
          this.rooms = this.rooms.filter(r => newRoomIds.has(r.roomId));
          if (this.rooms.length !== originalLength) {
            changed = true;
            // If selected room was deleted, clear it
            if (this.selectedRoom && !newRoomIds.has(this.selectedRoom.roomId)) {
              this.selectedRoom = null;
              this.messages = [];
            }
          }

          // Add any brand-new rooms and update existing
          list.forEach(r => {
            const existing = this.rooms.find(e => e.roomId === r.roomId);
            if (!existing) {
              if (r.type === 'DIRECT' && (!r.name || r.name.toLowerCase() === 'direct message' || r.name.startsWith('DIRECT_'))) {
                r.name = 'Loading...';
                this.fetchDirectRoomName(r);
              }
              this.sanitizeRoom(r);
              this.rooms.push(r);
              changed = true;
            } else {
              // Fetch direct room name if it was stuck on loading or default
              if (existing.type === 'DIRECT' && (!existing.name || existing.name.toLowerCase() === 'direct message' || existing.name.startsWith('DIRECT_') || existing.name === 'Loading...')) {
                if (r.name && r.name !== 'Loading...' && !r.name.toLowerCase().includes('direct message') && !r.name.startsWith('DIRECT_')) {
                  existing.name = r.name;
                } else {
                  existing.name = 'Loading...';
                  this.fetchDirectRoomName(existing);
                }
              }
              
              // Patch the unreadCount in-place
              const newCount = this.selectedRoom?.roomId === r.roomId ? 0 : (r.unreadCount ?? 0);
              if (existing.unreadCount !== newCount) {
                existing.unreadCount = newCount;
                changed = true;
              }
              
              // Update name and avatar if it changed (for non-direct rooms)
              if (r.type !== 'DIRECT' && (existing.name !== r.name || existing.avatarUrl !== r.avatarUrl)) {
                 existing.name = r.name;
                 existing.avatarUrl = this.cleanUrl(r.avatarUrl) ?? r.avatarUrl;
                 changed = true;
              }
              
              // Patch memberCount if changed
              if (existing.memberCount !== r.memberCount) {
                existing.memberCount = r.memberCount;
                changed = true;
              }
            }
          });

          if (changed) this.cdr.detectChanges();
        });
      },
      error: (err) => console.error('Failed to refresh rooms:', err)
    });
  }

  private fetchDirectRoomName(room: Room): void {
    this.roomService.getMembers(room.roomId).subscribe({
      next: (members) => {
        const otherMember = members.find(m => m.userId !== this.currentUser?.userId);
        if (otherMember) {
          this.authService.getUserById(otherMember.userId).subscribe({
            next: (u) => {
              this.sanitizeUser(u);
              room.name = u.fullName || u.username;
              room.avatarUrl = u.avatarUrl || room.avatarUrl;
              this.cdr.detectChanges();
            },
            error: (err) => {
              if (err.status === 404) {
                room.name = 'Deleted User';
                this.cdr.detectChanges();
              }
            }
          });
        }
      }
    });
  }

  getOtherDirectMember(): any {
    if (this.selectedRoom?.type !== 'DIRECT' || !this.currentUser) return null;
    return this.roomMembersWithDetails.find(m => m.userId !== this.currentUser?.userId);
  }

  loadUnreadNotifications(): void {
    if (this.currentUser) {
      this.notifService.getUnreadCount().subscribe({
        next: (res) => {
          this.ngZone.run(() => {
            this.unreadNotificationCount = res.count;
            this.cdr.detectChanges();
          });
        }
      });
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (this.showNotifPanel && !target.closest('.notif-badge-container') && !target.closest('.notif-panel')) {
      this.showNotifPanel = false;
    }
  }

  toggleNotifPanel(): void {
    this.showNotifPanel = !this.showNotifPanel;
    if (this.showNotifPanel) {
      this.notifLoading = true;
      this.notifService.getNotifications().subscribe({
        next: (notifs) => {
          this.ngZone.run(() => {
            this.notifications = notifs;
            this.notifLoading = false;
            // Refresh unread count after opening panel
            this.loadUnreadNotifications();
            this.cdr.detectChanges();
          });
        },
        error: () => { this.notifLoading = false; }
      });
    }
  }

  markNotifRead(notif: AppNotification): void {
    if (notif.isRead) return;
    this.notifService.markAsRead(notif.notificationId).subscribe({
      next: () => {
        this.ngZone.run(() => {
          notif.isRead = true;
          this.unreadNotificationCount = Math.max(0, this.unreadNotificationCount - 1);
          this.cdr.detectChanges();
        });
      }
    });
  }

  markAllNotifsRead(): void {
    this.notifications.filter(n => !n.isRead).forEach(n => this.markNotifRead(n));
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    if (this.currentUser) {
      this.presenceService.setOffline(this.currentUser.userId).subscribe({ error: () => {} });
    }
    this.subscriptions.forEach(s => s.unsubscribe());
    this.wsService.disconnect();
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    if (this.roomRefreshInterval) clearInterval(this.roomRefreshInterval);
    if (this.notifPollInterval) clearInterval(this.notifPollInterval);
    if (this.broadcastDismissTimer) clearTimeout(this.broadcastDismissTimer);
  }

  /** Show the broadcast banner and auto-dismiss after 30 seconds */
  showBroadcastBanner(broadcast: { title: string; message: string; subType: string }): void {
    this.activeBroadcast = broadcast;
    if (this.broadcastDismissTimer) clearTimeout(this.broadcastDismissTimer);
    this.broadcastDismissTimer = setTimeout(() => this.dismissBroadcast(), 30000);
    this.cdr.detectChanges();
  }

  dismissBroadcast(): void {
    this.activeBroadcast = null;
    if (this.broadcastDismissTimer) {
      clearTimeout(this.broadcastDismissTimer);
      this.broadcastDismissTimer = null;
    }
    this.cdr.detectChanges();
  }

  /** Mobile back button — deselect room and open sidebar drawer */
  goBack(): void {
    if (this.selectedRoom) {
      this.wsService.unsubscribeFromRoom(this.selectedRoom.roomId);
    }
    this.selectedRoom = null;
    this.messages = [];
    this.mobileSidebarOpen = true;
    this.cdr.detectChanges();
  }

  // =========================================================================
  // Room Management
  // =========================================================================

  loadRooms(retryCount: number = 0): void {
    // Guard: don't attempt if no token is present (e.g. OAuth redirect race condition)
    if (!localStorage.getItem('authToken')) {
      this.loadingRooms = false;
      return;
    }
    this.loadingRooms = true;
    this.roomService.getMyRooms().subscribe({
      next: (rooms) => {
        this.ngZone.run(() => {
          // Handle both a plain array and an accidentally wrapped page object
          this.rooms = Array.isArray(rooms) ? rooms : (rooms as any).content ?? [];
          // Sanitize room avatar URLs at load time
          this.rooms.forEach(r => this.sanitizeRoom(r));
          
          // Update direct message names
          this.rooms.forEach(r => {
            if (r.type === 'DIRECT' && (!r.name || r.name.toLowerCase() === 'direct message' || r.name.startsWith('DIRECT_'))) {
              r.name = 'Loading...'; // Prevent "Direct message" flicker
              this.roomService.getMembers(r.roomId).subscribe({
                next: (members) => {
                  const otherMember = members.find(m => m.userId !== this.currentUser?.userId);
                  if (otherMember) {
                    this.authService.getUserById(otherMember.userId).subscribe({
                      next: (u) => {
                        this.sanitizeUser(u);
                        r.name = u.fullName || u.username;
                        r.avatarUrl = u.avatarUrl || r.avatarUrl;
                        this.cdr.detectChanges();
                      },
                      error: (err) => {
                        if (err.status === 404) {
                          r.name = 'Deleted User';
                          r.avatarUrl = '';
                          this.cdr.detectChanges();
                        }
                      }
                    });
                  }
                }
              });
            }
          });

          this.loadingRooms = false;
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        console.error('Failed to load rooms:', err);
        // Do NOT retry on auth failures — interceptor already redirects to login
        const isAuthError = err?.status === 401 || err?.status === 403 ||
          err?.message?.includes('No refresh token');
        if (!isAuthError && retryCount < 3) {
          setTimeout(() => this.loadRooms(retryCount + 1), 1000);
        } else {
          this.ngZone.run(() => {
            this.loadingRooms = false;
            this.cdr.detectChanges();
          });
        }
      }
    });
  }

  selectRoom(room: Room): void {
    // Unsubscribe from previous room
    if (this.selectedRoom) {
      this.wsService.unsubscribeFromRoom(this.selectedRoom.roomId);
    }

    this.selectedRoom = room;
    this.messages = [];
    this.loadingMessages = true;
    this.mobileSidebarOpen = false; // close drawer on mobile when room is selected
    
    // Reset pagination & search state
    this.hasMoreMessages = true;
    this.oldestMessageDate = null;
    this.loadingMoreMessages = false;
    this.showMessageSearch = false;
    this.messageSearchTerm = '';
    this.isSearching = false;
    
    // Clear unread count locally and sync with backend
    const localRoom = this.rooms.find(r => r.roomId === room.roomId);
    if (localRoom) localRoom.unreadCount = 0;
    this.roomService.markAsRead(room.roomId).subscribe();
    
    // Also clear notifications for this room
    this.notifService.getNotifications().subscribe({
      next: (notifs) => {
        notifs.filter(n => !n.isRead && n.roomId === room.roomId && (n.type === 'NEW_MESSAGE' || n.type === 'MENTION')).forEach(n => {
           this.markNotifRead(n);
           // Immediately sync with the panel list so dots disappear
           if (this.notifications) {
             const panelNotif = this.notifications.find(pn => pn.notificationId === n.notificationId);
             if (panelNotif) {
               panelNotif.isRead = true;
               (panelNotif as any).read = true;
             }
           }
        });
      }
    });

    // Subscribe to room's STOMP topic for real-time messages
    this.wsService.subscribeToRoom(room.roomId);

    // Load message history via REST
    this.loadMessages(room.roomId);
    
    // Load members for mentions & permissions
    this.loadMembersForMentions(room.roomId);
    
    // Pre-load members to enable permission checks like isOwner() before opening Room Info
    if (!this.showRoomInfoModal) {
      this.loadRoomMembers(true); // background load
    }
  }

  loadMembersForMentions(roomId: string): void {
    this.currentRoomUsers = [];
    this.roomService.getMembers(roomId).subscribe({
      next: (members) => {
        console.log('Mention system: room members found:', members.length);
        members.forEach(member => {
          if (member.userId !== this.currentUser?.userId) {
            this.authService.getUserById(member.userId).subscribe({
              next: (u) => {
                this.sanitizeUser(u);
                this.currentRoomUsers.push(u);
                console.log('Mention system: added user', u.username);
              },
              error: (err) => {
                if (err.status !== 404) {
                  console.error('Mention system: failed to get user', err);
                }
              }
            });
          }
        });
      },
      error: (err) => console.error('Mention system: failed to get room members', err)
    });
  }


  loadMessages(roomId: string): void {
    this.loadingMessages = true;
    this.messageService.getMessages(roomId, 0, 50).subscribe({
      next: (page) => {
        this.ngZone.run(() => {
          this.loadingMessages = false;
          // REST API returns page content sorted newest-first, so we reverse it.
          // IMPORTANT: Don't regress deliveryStatus in the UI if we've already
          // locally upgraded it to DELIVERED/READ via WebSocket events.
          this.messages = [...page.content]
            .reverse()
            .map(m => {
              const deliveryStatus = this.getCachedOrIncomingStatus(m.messageId, m.deliveryStatus);
              this.cacheStatus(m.messageId, deliveryStatus);
              return { ...m, deliveryStatus };
            });
          
          if (this.messages.length > 0) {
            this.oldestMessageDate = this.messages[0].sentAt || this.messages[0].timestamp || null;
            if (page.content.length < 50) this.hasMoreMessages = false;
          } else {
            this.hasMoreMessages = false;
          }

          this.cdr.detectChanges();
          this.scrollToBottom();

          // If we just opened the room, we likely loaded existing history via REST.
          // Send DELIVERED + READ receipts up to the latest message so the sender can
          // see accurate ticks even for messages that were sent before this client connected.
          const last = this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
          if (
            last?.messageId &&
            this.currentUser &&
            last.senderId !== this.currentUser.userId
          ) {
            // 1) DELIVERED: recipient session has received the message payload
            this.wsService.sendDeliveryReceipt(roomId, this.currentUser.userId, last.messageId);
            // 2) READ: recipient has opened the room (treat as read)
            setTimeout(() => {
              this.wsService.sendReadReceipt(roomId, this.currentUser!.userId, last.messageId!);
            }, 150);
          }

        });
      },

      error: (err: any) => {
        console.error('Failed to load messages:', err);
        this.ngZone.run(() => {
          this.loadingMessages = false;
          this.cdr.detectChanges();
        });
      }
    });
  }

  createRoom(): void {
    if (!this.newRoomName.trim()) return;

    this.roomService.createRoom({
      name: this.newRoomName.trim(),
      description: this.newRoomDescription.trim() || undefined,
      type: this.newRoomType,
      memberIds: this.newRoomMembers.length > 0 ? this.newRoomMembers : undefined,
      maxMemberLimit: this.newRoomMaxMembers || undefined
    }).subscribe({
      next: (room) => {
        this.ngZone.run(() => {
          this.rooms.unshift(room);
          
          // Members were already added server-side via memberIds in the create payload.
          // No separate addMember calls needed — they would cause 409 Conflict.
          
          this.selectRoom(room);
          this.showCreateRoom = false;
          this.newRoomName = '';
          this.newRoomDescription = '';
          this.newRoomMaxMembers = null;
          this.newRoomMembers = [];
          this.selectedMembersForNewRoom = [];
          this.newRoomMemberSearch = '';
          this.newRoomMemberSearchResults = [];
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        this.ngZone.run(() => {
          console.error('Failed to create room:', err);
          alert('Failed to create room. Please try again.');
          this.cdr.detectChanges();
        });
      }
    });
  }

  searchNewRoomMembers(): void {
    if (!this.newRoomMemberSearch.trim() || this.newRoomMemberSearch.length < 2) {
      this.newRoomMemberSearchResults = [];
      return;
    }

    this.newRoomMemberSearchLoading = true;
    this.authService.searchUsers(this.newRoomMemberSearch).subscribe({
      next: (users) => {
        this.ngZone.run(() => {
          this.newRoomMemberSearchLoading = false;
          // Filter out already selected members and current user
          this.newRoomMemberSearchResults = users.filter(u => 
            !this.newRoomMembers.includes(u.userId) && u.userId !== this.currentUser?.userId
          );
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        console.error('Failed to search members for new room:', err);
        this.newRoomMemberSearchLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  openGallery(): void {
    if (!this.selectedRoom) return;
    this.showGalleryModal = true;
    this.galleryLoading = true;
    this.messageService.getMediaGallery(this.selectedRoom.roomId).subscribe({
      next: (msgs) => {
        this.ngZone.run(() => {
          this.galleryMessages = msgs;
          this.galleryLoading = false;
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        this.ngZone.run(() => {
          console.error('Failed to load gallery:', err);
          this.galleryLoading = false;
          this.cdr.detectChanges();
        });
      }
    });
  }

  closeGallery(): void {
    this.showGalleryModal = false;
  }

  addMemberToNewRoom(user: User): void {
    if (!this.newRoomMembers.includes(user.userId)) {
      this.newRoomMembers.push(user.userId);
      this.selectedMembersForNewRoom.push(user);
      this.newRoomMemberSearch = '';
      this.newRoomMemberSearchResults = [];
    }
  }

  removeMemberFromNewRoom(userId: string): void {
    this.newRoomMembers = this.newRoomMembers.filter(id => id !== userId);
    this.selectedMembersForNewRoom = this.selectedMembersForNewRoom.filter(u => u.userId !== userId);
  }

  // =========================================================================
  // Message Sending
  // =========================================================================

  sendMessage(): void {
    if (!this.newMessage.trim() || !this.selectedRoom || !this.currentUser || this.isCurrentUserMuted()) return;

    const content = this.newMessage.trim();
    this.newMessage = '';
    const senderName = this.currentUser.fullName || this.currentUser.username;

    this.sendingMessage = true;

    if (this.editingMessage) {
      // Handle Edit
      const targetMessage = this.editingMessage;
      this.messageService.editMessage(targetMessage.messageId!, this.currentUser.userId, content).subscribe({
        next: (updated) => {
          this.ngZone.run(() => {
            this.sendingMessage = false;
            // Update local message
            const index = this.messages.findIndex(m => m.messageId === updated.messageId);
            if (index !== -1) {
              this.messages[index] = { ...this.messages[index], ...updated };
            }
            this.cdr.detectChanges();
            
            // Broadcast edit via WebSocket
            this.wsService.sendEdit(this.selectedRoom!.roomId, updated.messageId!);
            this.cancelAction();
          });
        },
        error: (error) => {
          this.ngZone.run(() => {
            this.sendingMessage = false;
            console.error('Failed to edit message:', error);
            this.newMessage = content;
            this.cdr.detectChanges();
            alert('Failed to edit message. Please try again.');
          });
        }
      });
      return;
    }

    // Handle New Message (with optional replyTo)
    this.messageService.sendMessage({
      roomId: this.selectedRoom.roomId,
      senderId: this.currentUser.userId,
      senderName,
      content,
      type: 'TEXT',
      replyToMessageId: this.replyingToMessage?.messageId
    }).subscribe({
      next: (saved) => {
        this.ngZone.run(() => {
          this.sendingMessage = false;
          
          const status = (saved.deliveryStatus || 'SENT') as any;
          this.cacheStatus(saved.messageId, status);
          this.messages = [...this.messages, { ...saved, eventType: 'CHAT', deliveryStatus: status }];
          this.cdr.detectChanges();
          this.scrollToBottom();
          
          this.wsService.sendMessage({ ...saved, eventType: 'CHAT' });
          this.cancelAction();
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.sendingMessage = false;
          console.error('Failed to send message:', error);
          this.newMessage = content; 
          this.cdr.detectChanges();
          alert('Failed to send message. Please try again.');
        });
      }
    });

    setTimeout(() => this.messageInput?.nativeElement?.focus(), 0);
  }

  // =========================================================================
  // Message Actions (UI handlers)
  // =========================================================================

  initiateReply(msg: ChatMessage): void {
    this.replyingToMessage = msg;
    this.editingMessage = null;
    setTimeout(() => this.messageInput?.nativeElement?.focus(), 0);
  }

  initiateEdit(msg: ChatMessage): void {
    if (!this.isMyMessage(msg)) return;
    this.editingMessage = msg;
    this.replyingToMessage = null;
    this.newMessage = msg.content || '';
    setTimeout(() => this.messageInput?.nativeElement?.focus(), 0);
  }

  cancelAction(): void {
    this.replyingToMessage = null;
    if (this.editingMessage) {
      this.newMessage = '';
      this.editingMessage = null;
    }
  }

  deleteMessage(msg: ChatMessage): void {
    if (!this.currentUser || !this.selectedRoom) return;
    if (confirm('Are you sure you want to delete this message?')) {
      this.messageService.deleteMessage(msg.messageId!, this.currentUser.userId).subscribe({
        next: () => {
          this.ngZone.run(() => {
            const index = this.messages.findIndex(m => m.messageId === msg.messageId);
            if (index !== -1) {
              this.messages[index].isDeleted = true;
            }
            this.cdr.detectChanges();
            this.wsService.sendDelete(this.selectedRoom!.roomId, msg.messageId!);
          });
        },
        error: (err: any) => {
          console.error('Failed to delete message:', err);
          alert('Could not delete message.');
        }
      });
    }
  }

  pinMessage(msg: ChatMessage): void {
    if (!this.currentUser || !this.selectedRoom) return;
    const isCurrentlyPinned = msg.isPinned || false;
    this.messageService.pinMessage(msg.messageId!, !isCurrentlyPinned).subscribe({
      next: (updatedMsg) => {
        this.ngZone.run(() => {
          const index = this.messages.findIndex(m => m.messageId === msg.messageId);
          if (index !== -1) {
            this.messages[index].isPinned = updatedMsg.isPinned;
          }
          this.cdr.detectChanges();
          // Broadcast pin event so other clients sync immediately
          this.wsService.sendPin(this.selectedRoom!.roomId, msg.messageId!, updatedMsg.isPinned || false);
        });
      },
      error: (err: any) => {
        console.error('Failed to pin/unpin message:', err);
        alert('Could not pin/unpin message.');
      }
    });
  }

  getPinnedMessages(): ChatMessage[] {
    if (!this.messages) return [];
    return this.messages.filter(msg => msg.isPinned && !msg.isDeleted);
  }

  getCurrentPinnedMessage(): ChatMessage | null {
    const pinned = this.getPinnedMessages();
    if (!pinned.length) return null;
    // clamp index in case messages were unpinned
    if (this.pinnedMessageIndex >= pinned.length) {
      this.pinnedMessageIndex = pinned.length - 1;
    }
    return pinned[this.pinnedMessageIndex];
  }

  navigatePinnedMessage(direction: 1 | -1, event: Event): void {
    event.stopPropagation();
    const pinned = this.getPinnedMessages();
    if (!pinned.length) return;
    this.pinnedMessageIndex = (this.pinnedMessageIndex + direction + pinned.length) % pinned.length;
    this.cdr.detectChanges();
  }

  getPinnedMessagePreview(msg: ChatMessage): { text: string, icon: string } {
    if (msg.type === 'TEXT') {
      return { text: msg.content, icon: 'push_pin' };
    }
    const fileName = this.getFileNameFromMessage(msg);
    const icon = this.getFileIcon(msg);
    return { text: fileName, icon: icon };
  }

  clearRoomHistory(): void {
    if (!this.selectedRoom) return;
    if (confirm('Are you sure you want to permanently delete ALL messages in this room? This action cannot be undone.')) {
      this.messageService.clearRoomHistory(this.selectedRoom.roomId).subscribe({
        next: () => {
          this.ngZone.run(() => {
            this.messages = [];
            this.showRoomSettingsModal = false;
            this.cdr.detectChanges();
          });
        },
        error: (err: any) => {
          console.error('Failed to clear room history:', err);
          alert('Could not clear room history.');
        }
      });
    }
  }

  reactToMessage(msg: ChatMessage, emoji: string): void {
    if (!this.currentUser || !this.selectedRoom) return;
    this.showReactionPickerFor = null;
    
    // Call REST API to persist reaction
    this.messageService.reactToMessage(msg.messageId!, emoji).subscribe({
      next: () => {
        // Broadcast reaction so others (and our own WebSocket listener) see it
        // The UI will update when the WebSocket event is received back
        this.wsService.sendReaction(this.selectedRoom!.roomId, this.currentUser!.userId, msg.messageId!, emoji);
      },
      error: (err) => console.error('Failed to react to message:', err)
    });
  }

  onFileSelected(event: any): void {
    const file = event.target.files[0];
    if (!file || !this.selectedRoom || !this.currentUser) return;
    
    this.uploadingFile = true;
    const isImage = file.type.startsWith('image/');
    // Encode filename + size so the chat card can display them
    const fileMetaContent = isImage
      ? JSON.stringify({ type: 'image', name: file.name, size: file.size })
      : JSON.stringify({ type: 'file', name: file.name, size: file.size });

    const uploadOp = isImage 
      ? this.mediaService.uploadImage(file, this.selectedRoom.roomId, this.currentUser.userId)
      : this.mediaService.uploadFile(file, this.selectedRoom.roomId, this.currentUser.userId);

    uploadOp.subscribe({
      next: (res) => {
        // Persist media message via REST.
        // Use presignedUrl (not res.url) — the bucket is private, the public URL is inaccessible.
        this.messageService.sendMessage({
          roomId: this.selectedRoom!.roomId,
          senderId: this.currentUser!.userId,
          senderName: this.currentUser!.fullName || this.currentUser!.username,
          content: fileMetaContent,
          mediaUrl: res.presignedUrl,
          thumbnailUrl: res.thumbnailUrl,
          type: isImage ? 'IMAGE' : 'FILE'
        }).subscribe({
          next: (saved) => {
            this.ngZone.run(() => {
              this.uploadingFile = false;
              // Send via WebSocket after DB persistence
              this.wsService.sendMessage({ ...saved, eventType: 'CHAT' });
              this.messages = [...this.messages, { ...saved, eventType: 'CHAT' }];
              this.cdr.detectChanges();
              this.scrollToBottom();
            });
          },
          error: (msgErr) => {
            this.ngZone.run(() => {
              this.uploadingFile = false;
              console.error('Media uploaded to S3 but failed to save message:', msgErr);
              this.cdr.detectChanges();
              alert('File uploaded but failed to send message. Please try again.');
            });
          }
        });
      },
      error: (uploadErr) => {
        this.ngZone.run(() => {
          this.uploadingFile = false;
          this.cdr.detectChanges();
          const status = uploadErr?.status;
          const msg = uploadErr?.error?.error || uploadErr?.message || 'Unknown error';
          console.error('File upload failed:', uploadErr);
          alert(`Failed to upload file (${status || 'network error'}): ${msg}`);
        });
      }
    });
    
    // reset input
    event.target.value = null;
  }

  /** Extract original file name from the JSON content field of a media message. */
  getFileNameFromMessage(msg: ChatMessage): string {
    try {
      const meta = JSON.parse(msg.content || '');
      return meta.name || 'Unknown file';
    } catch {
      // Fallback: try to parse the last path segment from the presigned URL key
      if (msg.mediaUrl) {
        const urlPart = msg.mediaUrl.split('?')[0]; // strip query
        const segments = urlPart.split('/');
        return decodeURIComponent(segments[segments.length - 1] || 'file');
      }
      return 'File';
    }
  }

  /** Extract file extension (lowercase, no dot). */
  getFileExtension(msg: ChatMessage): string {
    const name = this.getFileNameFromMessage(msg);
    const parts = name.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }

  /** Return a material-icons-round icon name per file extension. */
  getFileIcon(msg: ChatMessage): string {
    const ext = this.getFileExtension(msg);
    const map: Record<string, string> = {
      // images
      jpg: 'image', jpeg: 'image', png: 'image', gif: 'gif_box', webp: 'image', svg: 'image',
      // documents
      pdf: 'picture_as_pdf',
      doc: 'description', docx: 'description',
      xls: 'table_chart', xlsx: 'table_chart',
      ppt: 'slideshow', pptx: 'slideshow',
      zip: 'folder_zip', rar: 'folder_zip', gz: 'folder_zip',
      mp4: 'videocam', mov: 'videocam', avi: 'videocam', mkv: 'videocam',
      mp3: 'audiotrack', wav: 'audiotrack', ogg: 'audiotrack',
      txt: 'article',
      csv: 'table_rows',
      json: 'data_object',
    };
    return map[ext] || 'insert_drive_file';
  }

  /** Return accent colour per file extension group. */
  getFileIconColor(msg: ChatMessage): string {
    const ext = this.getFileExtension(msg);
    if (ext === 'pdf') return '#ef4444';
    if (['jpg','jpeg','png','gif','webp','svg'].includes(ext)) return '#0ea5e9';
    if (['doc','docx'].includes(ext)) return '#3b82f6';
    if (['xls','xlsx','csv'].includes(ext)) return '#22c55e';
    if (['ppt','pptx'].includes(ext)) return '#f97316';
    if (['zip','rar','gz'].includes(ext)) return '#a855f7';
    if (['mp4','mov','avi','mkv'].includes(ext)) return '#ec4899';
    if (['mp3','wav','ogg'].includes(ext)) return '#06b6d4';
    return '#6c63ff';
  }

  /** Format bytes to human-readable size string. */
  formatFileSize(bytes: number): string {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Returns file size string for a media message.
   * 1. Tries JSON-encoded content (new uploads).
   * 2. Falls back to an async Range request against the presigned URL (old uploads).
   *    The result is cached so we fetch only once per message per session.
   */
  getFileSizeFromMessage(msg: ChatMessage): string {
    // Path 1 — new uploads: content is JSON with { name, size, type }
    try {
      const meta = JSON.parse(msg.content || '');
      if (meta.size && meta.size > 0) {
        return this.formatFileSize(meta.size);
      }
    } catch { /* not JSON — old message */ }

    // Path 2 — old uploads: try cache first
    const msgId = msg.messageId || '';
    if (this.fileSizeCache.has(msgId)) {
      return this.fileSizeCache.get(msgId)!;
    }

    // Path 3 — kick off a background fetch if we have a valid URL and not already fetching
    if (msg.mediaUrl && msgId && !this.fileSizeFetching.has(msgId)) {
      this.fileSizeFetching.add(msgId);
      this.fetchFileSizeFromUrl(msg.mediaUrl, msgId);
    }

    return ''; // placeholder until async fetch resolves
  }

  /** Async: fetch first byte of the presigned URL to read Content-Range total size. */
  private fetchFileSizeFromUrl(url: string, msgId: string): void {
    fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      mode: 'cors'
    })
    .then(res => {
      let sizeStr = '';
      // Content-Range: bytes 0-0/TOTALSIZE
      const cr = res.headers.get('Content-Range');
      if (cr) {
        const total = parseInt(cr.split('/')[1], 10);
        if (!isNaN(total) && total > 0) sizeStr = this.formatFileSize(total);
      }
      // Fallback: Content-Length (206 partial response or 200)
      if (!sizeStr) {
        const cl = res.headers.get('Content-Length');
        if (cl) {
          const n = parseInt(cl, 10);
          if (!isNaN(n) && n > 0) sizeStr = this.formatFileSize(n);
        }
      }
      // Abort the body download (we only needed headers)
      res.body?.cancel?.();
      this.fileSizeCache.set(msgId, sizeStr);
      if (sizeStr) {
        this.ngZone.run(() => this.cdr.detectChanges());
      }
    })
    .catch(() => {
      // Network / CORS error — cache empty string so we don't retry
      this.fileSizeCache.set(msgId, '');
    })
    .finally(() => {
      this.fileSizeFetching.delete(msgId);
    });
  }

  onMessageInput(event: any): void {
    this.onTyping();
    const cursor = event.target.selectionStart;
    const textBeforeCursor = this.newMessage.substring(0, cursor);
    
    // Check if we are typing a mention
    const match = textBeforeCursor.match(/@(\w*)$/);
    console.log('Mention system input check. Match:', match, 'CurrentRoomUsers length:', this.currentRoomUsers.length);
    
    if (match) {
      this.showMentionPopup = true;
      this.mentionSearchTerm = match[1].toLowerCase();
      this.mentionSuggestions = this.currentRoomUsers.filter(u => 
        (u.username && u.username.toLowerCase().includes(this.mentionSearchTerm)) ||
        (u.fullName && u.fullName.toLowerCase().includes(this.mentionSearchTerm))
      );
      console.log('Mention suggestions found:', this.mentionSuggestions.length);
    } else {
      this.showMentionPopup = false;
    }
  }

  insertMention(user: User): void {
    const inputEl = this.messageInput.nativeElement;
    const cursor = inputEl.selectionStart;
    const textBeforeCursor = this.newMessage.substring(0, cursor);
    const textAfterCursor = this.newMessage.substring(cursor);
    
    // Replace the @term with @username 
    const newTextBefore = textBeforeCursor.replace(/@\w*$/, `@${user.username} `);
    this.newMessage = newTextBefore + textAfterCursor;
    
    this.showMentionPopup = false;
    
    // Refocus and set cursor
    setTimeout(() => {
      inputEl.focus();
      const newCursor = newTextBefore.length;
      inputEl.setSelectionRange(newCursor, newCursor);
    }, 0);
  }

  onTyping(): void {
    if (!this.selectedRoom || !this.currentUser) return;

    // Send typing indicator (throttled — only once per 2 seconds)
    if (!this.typingTimeout) {
      this.wsService.sendTyping(
        this.selectedRoom.roomId,
        this.currentUser.userId,
        this.currentUser.fullName || this.currentUser.username
      );
      this.typingTimeout = setTimeout(() => {
        this.typingTimeout = null;
      }, 2000);
    }
  }

  addEmoji(emoji: string): void {
    this.newMessage += emoji;
    this.showEmojiPicker = false;
    this.messageInput?.nativeElement?.focus();
  }

  // =========================================================================
  // WebSocket Event Handlers
  // =========================================================================

  private onMessageReceived(msg: ChatMessage): void {
    console.log('[Chat] onMessageReceived eventType=', msg.eventType, 'messageId=', msg.messageId, 'roomId=', msg.roomId);
    if (msg.eventType === 'EDIT' || msg.eventType === 'PIN') {
      this.ngZone.run(() => {
        const index = this.messages.findIndex(m => m.messageId === msg.messageId);
        if (index !== -1) {
          this.messages[index] = { 
            ...this.messages[index], 
            content: msg.content || this.messages[index].content, 
            isEdited: msg.eventType === 'EDIT' ? true : this.messages[index].isEdited,
            isPinned: msg.isPinned !== undefined ? msg.isPinned : this.messages[index].isPinned
          };
          this.cdr.detectChanges();
        }
      });
      return;
    }

    if (msg.eventType === 'DELETE') {
      this.ngZone.run(() => {
        const deletedId = (msg.messageId || msg.targetMessageId) as string;
        console.log('[Chat] DELETE handler, deletedId=', deletedId, 'messages count=', this.messages.length);
        const index = this.messages.findIndex(m => m.messageId === deletedId);
        console.log('[Chat] DELETE index found=', index);
        if (index !== -1) {
          this.messages = [
            ...this.messages.slice(0, index),
            { ...this.messages[index], isDeleted: true, content: '' },
            ...this.messages.slice(index + 1)
          ];
          this.cdr.detectChanges();
        }
      });
      return;
    }

    // CHAT replay / duplicate frame: merge into existing bubble — never downgrade deliveryStatus to SENT.
    const evt = (msg.eventType || 'CHAT').toString().toUpperCase();
    if (
      evt === 'CHAT' &&
      msg.messageId &&
      this.selectedRoom &&
      msg.roomId === this.selectedRoom.roomId
    ) {
      const dupIdx = this.messages.findIndex(m => m.messageId === msg.messageId);
      if (dupIdx !== -1) {
        this.ngZone.run(() => {
          const prev = this.messages[dupIdx];
          const merged: ChatMessage = { ...prev, ...msg };
          const incoming = (msg as any).deliveryStatus ?? prev.deliveryStatus;
          merged.deliveryStatus = this.getCachedOrIncomingStatus(msg.messageId, incoming) as any;
          this.cacheStatus(msg.messageId, merged.deliveryStatus);
          this.messages = [
            ...this.messages.slice(0, dupIdx),
            merged,
            ...this.messages.slice(dupIdx + 1)
          ];
          this.cdr.detectChanges();
        });
        return;
      }
    }

    // 1. Handle unread count for other rooms
    if (!this.selectedRoom || msg.roomId !== this.selectedRoom.roomId) {
      this.ngZone.run(() => {
        const room = this.rooms.find(r => r.roomId === msg.roomId);
        if (room) {
          room.unreadCount = (room.unreadCount || 0) + 1;
          this.cdr.detectChanges();
        }
        // Send a DELIVERY receipt since we received it but haven't read it
        if (this.currentUser && msg.messageId) {
          this.wsService.sendDeliveryReceipt(msg.roomId, this.currentUser.userId, msg.messageId);
        }
      });
      return;
    }

    // 2. Handle messages for the currently open room
    // Skip if we are the sender — we already added optimistically
    if (msg.senderId === this.currentUser?.userId) return;

    this.ngZone.run(() => {
      this.messages = [...this.messages, msg];
      this.typingUsers.delete(msg.senderId);
      this.cdr.detectChanges();
      this.scrollToBottom();

      // For an open room, we can model a two-step transition:
      // DELIVERED (we received it) → READ (we're viewing the room).
      if (this.currentUser && msg.messageId) {
        this.wsService.sendDeliveryReceipt(msg.roomId, this.currentUser.userId, msg.messageId);
        setTimeout(() => {
          this.roomService.markAsRead(msg.roomId).subscribe();
          this.wsService.sendReadReceipt(msg.roomId, this.currentUser!.userId, msg.messageId!);
        }, 150);
      }
    });
  }

  private onTypingReceived(msg: ChatMessage): void {
    if (!this.currentUser || msg.senderId === this.currentUser.userId) return;
    if (this.selectedRoom && msg.roomId === this.selectedRoom.roomId) {
      this.ngZone.run(() => {
        this.typingUsers.set(msg.senderId, msg.senderName || 'Someone');
        this.cdr.detectChanges();
        // Auto-clear typing after 3 seconds
        setTimeout(() => {
          this.typingUsers.delete(msg.senderId);
          this.cdr.detectChanges();
        }, 3000);
      });
    }
  }

  private onReadReceived(msg: ChatMessage): void {
    if (this.selectedRoom && msg.roomId === this.selectedRoom.roomId) {
      this.ngZone.run(() => {
        const upToId = msg.targetMessageId;
        if (!upToId || !this.currentUser) return;

        const upToIndex = this.messages.findIndex(m => m.messageId === upToId);
        // If the exact message isn't loaded, don't regress anything.
        // We'll get the correct persisted status on next REST fetch.
        if (upToIndex === -1) return;

        let changed = false;
        for (let i = 0; i <= upToIndex; i++) {
          const m = this.messages[i];
          if (m.senderId === this.currentUser.userId && m.deliveryStatus !== 'READ') {
            m.deliveryStatus = 'READ';
            this.cacheStatus(m.messageId, 'READ');
            changed = true;
          }
        }
        if (changed) this.cdr.detectChanges();
      });
    }
  }

  private onDeliveredReceived(msg: ChatMessage): void {
    if (this.selectedRoom && msg.roomId === this.selectedRoom.roomId) {
      this.ngZone.run(() => {
        const upToId = msg.targetMessageId;
        if (!upToId || !this.currentUser) return;

        const upToIndex = this.messages.findIndex(m => m.messageId === upToId);
        if (upToIndex === -1) return;

        let changed = false;
        for (let i = 0; i <= upToIndex; i++) {
          const m = this.messages[i];
          if (m.senderId === this.currentUser.userId && (m.deliveryStatus === 'SENT' || !m.deliveryStatus)) {
            m.deliveryStatus = 'DELIVERED';
            this.cacheStatus(m.messageId, 'DELIVERED');
            changed = true;
          }
        }
        if (changed) this.cdr.detectChanges();
      });
    }
  }

  private onReactionReceived(msg: ChatMessage): void {
    if (!this.selectedRoom || msg.roomId !== this.selectedRoom.roomId) return;
    this.ngZone.run(() => {
      if (msg.reaction === '__PIN__' || msg.reaction === '__UNPIN__') {
        const index = this.messages.findIndex(m => m.messageId === msg.targetMessageId);
        if (index !== -1) {
          this.messages[index].isPinned = msg.reaction === '__PIN__';
          this.cdr.detectChanges();
        }
        return;
      }
      const target = this.messages.find(m => m.messageId === msg.targetMessageId);
      if (target && msg.reaction) {
        if (!target.reactions) target.reactions = {};
        if (!target.reactions[msg.reaction]) target.reactions[msg.reaction] = 0;
        target.reactions[msg.reaction]++;
        this.cdr.detectChanges();
      }
    });
  }

  private onPresenceReceived(msg: ChatMessage): void {
    // We only care about presence if we have the room members loaded
    if (!this.selectedRoom || msg.roomId !== this.selectedRoom.roomId) return;

    this.ngZone.run(() => {
      const member = this.roomMembersWithDetails.find((m: any) => m.userId === msg.senderId);
      if (member) {
        member.onlineStatus = msg.status || 'offline';
        (member as any).status = msg.status || 'offline';
        if (msg.lastSeenAt) {
          (member as any).lastSeenAt =
            this.normalizeServerIso(msg.lastSeenAt) || msg.lastSeenAt;
        }
        this.cdr.detectChanges();

        // Some backend flows emit PRESENCE_UPDATE without lastSeenAt.
        // In that case, refresh from the status endpoint (which the current backend serves).
        if ((msg.status || 'offline') !== 'online' && !msg.lastSeenAt) {
          this.presenceService.getStatus(member.userId).subscribe({
            next: (statusObj) => {
              this.ngZone.run(() => {
                const normalized = this.normalizeServerIso(statusObj.lastSeen) || null;
                if (normalized) {
                  (member as any).lastSeenAt = normalized;
                }
                member.onlineStatus = statusObj.status || member.onlineStatus;
                (member as any).status = statusObj.status || (member as any).status;
                this.cdr.detectChanges();
              });
            },
            error: () => {}
          });
        }
      }
    });
  }

  // =========================================================================
  // UI Helpers
  // =========================================================================

  isMyMessage(msg: ChatMessage): boolean {
    return msg.senderId === this.currentUser?.userId;
  }

  getTypingText(): string {
    const names = Array.from(this.typingUsers.values());
    if (names.length === 0) return '';
    if (names.length === 1) return `${names[0]} is typing...`;
    return `${names.join(', ')} are typing...`;
  }

  getRoomInitial(room: Room): string {
    return room.name ? room.name.charAt(0).toUpperCase() : '?';
  }

  getRoomIcon(room: Room): string {
    switch (room.type) {
      case 'DIRECT': return 'person';
      case 'GROUP': return 'group';
      case 'CHANNEL': return 'tag';
      default: return 'chat';
    }
  }

  getMessageTime(msg: ChatMessage): string {
    const date = this.toDateFromServerIso(msg.sentAt || msg.timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private normalizeServerIso(value?: string | null): string | undefined {
    if (!value) return undefined;
    let v = String(value).trim();
    if (!v) return undefined;
    // Java LocalDateTime may include nanoseconds (e.g. .123456789) which
    // JS Date cannot parse reliably; trim to milliseconds.
    v = v.replace(/\.(\d{3})\d+/, '.$1');
    // If server sends LocalDateTime ("2026-05-04T12:34:56") treat as UTC to avoid timezone drift.
    const hasZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(v);
    return hasZone ? v : `${v}Z`;
  }

  private toDateFromServerIso(value?: string | null): Date {
    const norm = this.normalizeServerIso(value);
    const d = norm ? new Date(norm) : new Date(NaN);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  getLastSeenText(value?: string | null): string {
    const norm = this.normalizeServerIso(value);
    if (!norm) return '';
    const d = new Date(norm);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  getDeliveryText(msg: ChatMessage): string {
    switch (msg.deliveryStatus) {
      case 'READ': return 'Seen';
      case 'DELIVERED': return 'Delivered';
      case 'SENT': return 'Sent';
      default: return 'Sending...';
    }
  }

  // =========================================================================
  // Reply, Reaction & Pagination Helpers
  // =========================================================================

  onScroll(event: any): void {
    if (this.loadingMoreMessages || !this.hasMoreMessages || !this.selectedRoom) return;
    const element = event.target;
    // If scrolled to top
    if (element.scrollTop === 0) {
      this.loadOlderMessages();
    }
  }

  loadOlderMessages(): void {
    if (!this.selectedRoom || !this.oldestMessageDate || this.isSearching) return;
    this.loadingMoreMessages = true;
    
    // Remember scroll height before adding elements
    const el = this.messageContainer.nativeElement;
    const previousScrollHeight = el.scrollHeight;

    this.messageService.getMessagesBefore(this.selectedRoom.roomId, this.oldestMessageDate, 0, 50).subscribe({
      next: (page) => {
        this.ngZone.run(() => {
          this.loadingMoreMessages = false;
          if (page.content.length > 0) {
            const olderMessages = [...page.content].reverse();
            this.messages = [...olderMessages, ...this.messages];
            this.oldestMessageDate = this.messages[0].sentAt || this.messages[0].timestamp || null;
            if (page.content.length < 50) this.hasMoreMessages = false;
            
            this.cdr.detectChanges();
            // Restore scroll position
            setTimeout(() => {
              const newScrollHeight = el.scrollHeight;
              el.scrollTop = newScrollHeight - previousScrollHeight;
            }, 0);
          } else {
            this.hasMoreMessages = false;
            this.cdr.detectChanges();
          }
        });
      },
      error: (err: any) => {
        console.error('Failed to load older messages:', err);
        this.loadingMoreMessages = false;
      }
    });
  }

  // =========================================================================
  // Search Helpers
  // =========================================================================

  searchMessages(): void {
    if (!this.selectedRoom || !this.messageSearchTerm.trim()) return;
    
    this.loadingMessages = true;
    this.isSearching = true;
    this.hasMoreMessages = false; // Disable infinite scroll during search

    this.messageService.searchMessages(this.selectedRoom.roomId, this.messageSearchTerm.trim(), 0, 50).subscribe({
      next: (page) => {
        this.ngZone.run(() => {
          this.loadingMessages = false;
          // REST API returns page content sorted newest-first, reverse for display
          this.messages = [...page.content].reverse();
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        this.ngZone.run(() => {
          this.loadingMessages = false;
          console.error('Failed to search messages:', err);
          this.cdr.detectChanges();
        });
      }
    });
  }

  clearSearch(): void {
    if (!this.selectedRoom) return;
    this.showMessageSearch = false;
    this.messageSearchTerm = '';
    
    if (this.isSearching) {
      this.isSearching = false;
      this.messages = [];
      this.hasMoreMessages = true;
      this.loadMessages(this.selectedRoom.roomId);
    }
  }

  getMessagePreview(messageId: string): string {
    const msg = this.messages.find(m => m.messageId === messageId);
    if (!msg) return 'Original message not found';
    return msg.content ? (msg.content.length > 30 ? msg.content.substring(0, 30) + '...' : msg.content) : 'Attachment';
  }

  scrollToMessage(messageId: string): void {
    if (!messageId) return;
    const cleanId = messageId.startsWith('msg-') ? messageId : `msg-${messageId}`;
    const wrapperEl = document.getElementById(cleanId);
    if (!wrapperEl) return;

    wrapperEl.scrollIntoView({ behavior: 'instant', block: 'center' });

    const bubbleEl = (wrapperEl.querySelector('.message-bubble') as HTMLElement) || wrapperEl;

    // Save original styles
    const origBoxShadow = bubbleEl.style.boxShadow;
    const origTransition = bubbleEl.style.transition;
    const origBorder = bubbleEl.style.border;

    // Step 1: instantly apply the highlight
    bubbleEl.style.transition = 'none';
    bubbleEl.style.border = '2px solid #FBBF24';
    bubbleEl.style.boxShadow = '0 0 0 4px rgba(251,191,36,0.5)';

    // Step 2: after a short hold, fade it out smoothly
    setTimeout(() => {
      bubbleEl.style.transition = 'border 1.5s ease-out, box-shadow 1.5s ease-out';
      bubbleEl.style.border = origBorder || '';
      bubbleEl.style.boxShadow = origBoxShadow || '';

      // Step 3: restore transition
      setTimeout(() => {
        bubbleEl.style.transition = origTransition || '';
      }, 1600);
    }, 700);
  }

  getObjectKeys(obj: any): string[] {
    return obj ? Object.keys(obj) : [];
  }

  trackByMessageId(index: number, msg: ChatMessage): string {
    return msg.messageId || `${msg.senderId}-${msg.timestamp}-${index}`;
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.messageContainer) {
        const el = this.messageContainer.nativeElement;
        el.scrollTop = el.scrollHeight;
      }
    }, 100);
  }

  // =========================================================================
  // Unified Details Modal
  // =========================================================================

  openUserDetails(user: User | null | undefined): void {
    if (!user) return;
    this.detailsType = 'USER';
    this.detailsUser = user;
    this.showDetailsModal = true;
  }

  openRoomDetails(): void {
    if (!this.selectedRoom) return;
    this.detailsType = 'ROOM';
    this.detailsRoom = this.selectedRoom;
    this.showDetailsModal = true;
  }

  closeDetailsModal(): void {
    this.showDetailsModal = false;
  }

  getDetailsUserStatus(): string {
    if (!this.detailsUser) return 'offline';

    // Current user is always "online" (they are logged in and viewing)
    if (this.detailsUser.userId === this.currentUser?.userId) {
      const s = this.currentUser?.status?.toLowerCase() || 'online';
      return s === 'invisible' ? 'invisible' : s;
    }

    // Look up the actual connection status from the room member list
    const member = this.roomMembersWithDetails.find(m => m.userId === this.detailsUser!.userId);
    if (member) {
      // If they are not actually connected, always show offline
      if (member.onlineStatus !== 'online') return 'offline';
      // They are connected — use their custom status preference
      const customStatus = (this.detailsUser.status || member.user?.status || 'online').toLowerCase();
      return customStatus;
    }

    // Fallback: no member data found, use stored status
    return this.detailsUser.status?.toLowerCase() || 'offline';
  }

  getDotClass(status?: string): string {
    const s = (status || 'offline').toLowerCase();
    if (s === 'online') return 'status-dot status-online';
    if (s === 'away') return 'status-dot status-away';
    if (s === 'dnd') return 'status-dot status-dnd';
    if (s === 'invisible') return 'status-dot status-invisible';
    return 'status-dot status-offline';
  }

  getStatusText(status?: string): string {
    const s = (status || 'offline').toLowerCase();
    if (s === 'online') return 'Online';
    if (s === 'away') return 'Away';
    if (s === 'dnd') return 'Do Not Disturb';
    if (s === 'invisible') return 'Offline';
    return 'Offline';
  }

  getDirectUserStatusText(other: any): string {
    if (other.onlineStatus === 'online' && other.user?.status) {
      const s = other.user.status.toLowerCase();
      if (s === 'invisible') {
        return other.lastSeenAt ? 'Last seen ' + this.getLastSeenText(other.lastSeenAt) : 'Offline';
      }
      return this.getStatusText(s);
    }
    return other.lastSeenAt ? 'Last seen ' + this.getLastSeenText(other.lastSeenAt) : 'Offline';
  }

  getDesktopDirectUserStatusText(other: any): string {
    if (other.onlineStatus === 'online' && other.user?.status) {
      const s = other.user.status.toLowerCase();
      if (s === 'invisible') {
        return other.lastSeenAt ? 'Last seen ' + this.getLastSeenText(other.lastSeenAt) : 'Offline';
      }
      return this.getStatusText(s);
    }
    return other.lastSeenAt ? 'Last seen ' + this.getLastSeenText(other.lastSeenAt) : 'Offline';
  }

  // =========================================================================
  // Prime Upgrade Logic
  // =========================================================================

  openPrimeModal(): void {
    this.showPrimeModal = true;
    this.selectedPrimePlan = 'MONTHLY';
  }

  closePrimeModal(): void {
    this.showPrimeModal = false;
  }

  selectPrimePlan(plan: 'MONTHLY' | 'YEARLY'): void {
    this.selectedPrimePlan = plan;
  }

  upgradeToPrime(): void {
    this.upgradingPrime = true;
    this.paymentService.createOrder(this.selectedPrimePlan).subscribe({
      next: (order: any) => {
        const options = {
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          name: 'ConnectHub Prime',
          description: this.selectedPrimePlan === 'MONTHLY' ? 'Monthly Prime Subscription' : 'Yearly Prime Subscription',
          order_id: order.orderId,
          handler: (response: any) => {
            this.paymentService.verifyPayment(
              response.razorpay_payment_id,
              response.razorpay_order_id,
              response.razorpay_signature,
              this.selectedPrimePlan
            ).subscribe({
              next: (verifyRes: any) => {
                this.ngZone.run(() => {
                  alert(verifyRes.message);
                  if (this.currentUser) {
                    this.currentUser.isPrime = true;
                  }
                  this.showPrimeModal = false;
                  this.upgradingPrime = false;
                  this.cdr.detectChanges();
                });
              },
              error: (err: any) => {
                this.ngZone.run(() => {
                  alert('Payment verification failed');
                  this.upgradingPrime = false;
                  this.cdr.detectChanges();
                });
              }
            });
          },
          prefill: {
            name: this.currentUser?.fullName,
            email: this.currentUser?.email
          },
          theme: {
            color: '#6c63ff'
          },
          modal: {
            ondismiss: () => {
              this.ngZone.run(() => {
                this.upgradingPrime = false;
                this.cdr.detectChanges();
              });
            }
          }
        };

        const rzp = new Razorpay(options);
        rzp.open();
      },
      error: (err: any) => {
        alert('Could not initiate payment. Try again.');
        this.upgradingPrime = false;
        this.cdr.detectChanges();
      }
    });
  }

  // =========================================================================
  // Avatar Management
  // =========================================================================

  cleanUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const amzIndex = url.indexOf('?X-Amz-');
    if (amzIndex !== -1) return url.substring(0, amzIndex);
    return url;
  }

  /** Strip presigned S3 params from a user object's avatarUrl in-place, permanently. */
  private sanitizeUser(u: any): any {
    if (u?.avatarUrl) u.avatarUrl = this.cleanUrl(u.avatarUrl) ?? '';
    return u;
  }

  /** Strip presigned S3 params from a room object's avatarUrl in-place, permanently. */
  private sanitizeRoom(r: any): any {
    if (r?.avatarUrl) r.avatarUrl = this.cleanUrl(r.avatarUrl) ?? '';
    return r;
  }

  getUserAvatar(userId: string | undefined): string | null {
    if (!userId) return null;
    if (this.currentUser?.userId === userId) return this.currentUser.avatarUrl || null;
    const member = this.roomMembersWithDetails.find(m => m.userId === userId);
    return member?.user?.avatarUrl || null;
  }

  isUserPrimeOrAdmin(userId: string | undefined): boolean {
    if (!userId) return false;
    if (this.currentUser?.userId === userId) {
      return !!this.currentUser.isPrime || this.currentUser.role === 'ROLE_ADMIN';
    }
    const member = this.roomMembersWithDetails.find(m => m.userId === userId);
    return !!member?.user?.isPrime || member?.user?.role === 'ROLE_ADMIN';
  }

  getRoomAvatarUrl(room: Room): string | null {
    return room.avatarUrl || null;
  }

  handleAvatarError(userId: string | undefined): void {
    if (!userId) return;
    if (this.currentUser?.userId === userId) {
      if (this.currentUser) this.currentUser.avatarUrl = '';
      return;
    }
    const member = this.roomMembersWithDetails.find(m => m.userId === userId);
    if (member?.user) {
      member.user.avatarUrl = '';
    }
    const searchUser = this.userSearchResults.find(u => u.userId === userId);
    if (searchUser) searchUser.avatarUrl = '';
    const mentionUser = this.mentionSuggestions.find(u => u.userId === userId);
    if (mentionUser) mentionUser.avatarUrl = '';
    this.cdr.detectChanges();
  }

  uploadProfileAvatar(event: any): void {
    const file = event.target.files[0];
    if (!file || !this.currentUser) return;
    
    // Instant local preview
    const reader = new FileReader();
    reader.onload = (e: any) => {
      this.ngZone.run(() => {
        this.profileAvatarUrl = e.target.result;
        this.cdr.detectChanges();
      });
    };
    reader.readAsDataURL(file);

    // Use media service to upload image (pass dummy roomId as it doesn't matter for user profiles)
    this.mediaService.uploadImage(file, 'PROFILE', this.currentUser.userId).subscribe({
      next: (res) => {
        this.ngZone.run(() => {
          this.profileAvatarUrl = res.presignedUrl;
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        console.error('Failed to upload profile avatar:', err);
        alert('Failed to upload profile image.');
      }
    });
  }

  uploadRoomAvatar(event: any): void {
    const file = event.target.files[0];
    if (!file || !this.selectedRoom || !this.currentUser) return;
    
    this.mediaService.uploadImage(file, this.selectedRoom.roomId, this.currentUser.userId).subscribe({
      next: (res) => {
        this.ngZone.run(() => {
          this.roomSettingsAvatar = res.presignedUrl;
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        console.error('Failed to upload room avatar:', err);
        alert('Failed to upload room image.');
      }
    });
  }

  // Modal to show big profile pic
  showBigProfileModal = false;
  bigProfileUrl = '';
  
  openBigProfile(url: string | null | undefined): void {
    if (!url) return;
    this.bigProfileUrl = url;
    this.showBigProfileModal = true;
  }

  logout(): void {
    this.flushPresenceOfflineKeepalive();
    if (this.currentUser) {
      this.presenceService.setOffline(this.currentUser.userId).subscribe({ error: () => {} });
    }
    this.wsService.disconnect();
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  searchUsers(): void {
    const query = this.userSearchTerm.trim();

    if (query.length < 2) {
      this.userSearchResults = [];
      this.userSearchError = '';
      return;
    }

    this.userSearchLoading = true;
    this.userSearchError = '';

    this.authService.searchUsers(query).subscribe({
      next: (users) => {
        this.ngZone.run(() => {
          this.userSearchLoading = false;
          this.userSearchResults = users.filter(u => u.userId !== this.currentUser?.userId);
          this.userSearchResults.forEach(u => this.sanitizeUser(u));
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        this.ngZone.run(() => {
          this.userSearchLoading = false;
          this.userSearchError = err.error?.message || 'Could not search users right now.';
          this.cdr.detectChanges();
        });
      }
    });
  }

  clearUserSearch(): void {
    this.userSearchTerm = '';
    this.userSearchResults = [];
    this.userSearchError = '';
  }

  /**
   * Open (or create) a DM room with the given user, then select it.
   * Called when the user clicks a search result.
   */
  openDM(otherUser: User): void {
    if (!this.currentUser) return;
    this.dmLoading = true;
    this.clearUserSearch();

    this.roomService.getOrCreateDM(otherUser.userId).subscribe({
      next: (room) => {
        this.ngZone.run(() => {
          this.dmLoading = false;
          // Add to sidebar if not already there
          const exists = this.rooms.find(r => r.roomId === room.roomId);
          if (!exists) {
            if (room.type === 'DIRECT') {
              room.name = otherUser.fullName || otherUser.username;
            }
            this.rooms.unshift(room);
          } else if (exists.type === 'DIRECT') {
            exists.name = otherUser.fullName || otherUser.username;
          }
          this.selectRoom(exists ?? room);
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        this.ngZone.run(() => {
          this.dmLoading = false;
          console.error('Failed to open DM:', err);
          this.cdr.detectChanges();
        });
      }
    });
  }

  addUserToRoom(user: User): void {
    if (!this.selectedRoom || this.selectedRoom.type === 'DIRECT') return;
    this.roomService.addMember(this.selectedRoom.roomId, user.userId).subscribe({
      next: () => {
        this.ngZone.run(() => {
          alert(`${user.fullName || user.username} added to ${this.selectedRoom!.name}`);
          this.selectedRoom!.memberCount++;
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        this.ngZone.run(() => {
          alert(err.error?.message || 'Failed to add user to room');
          this.cdr.detectChanges();
        });
      }
    });
  }

  goToAdminPanel(): void {
    this.router.navigate(['/admin']);
  }

  openProfileModal(): void {
    if (!this.currentUser) return;
    this.profileUsername = this.currentUser.username || '';
    this.profileFullName = this.currentUser.fullName || '';
    this.profileBio = this.currentUser.bio || '';
    this.profileAvatarUrl = this.currentUser.avatarUrl || '';
    this.profileStatusMessage = this.currentUser.statusMessage || '';
    this.profileOnlineStatus = this.currentUser.status?.toLowerCase() || 'online';
    this.currentPassword = '';
    this.newPassword = '';
    this.confirmPassword = '';
    this.showProfileModal = true;
  }

  closeProfileModal(): void {
    this.showProfileModal = false;
  }

  saveProfile(): void {
    if (!this.currentUser) return;
    this.profileSaving = true;

    this.authService.updateProfile(this.currentUser.userId, {
      username: this.profileUsername.trim(),
      fullName: this.profileFullName.trim(),
      bio: this.profileBio.trim(),
      avatarUrl: this.profileAvatarUrl.trim(),
      statusMessage: this.profileStatusMessage.trim()
    }).subscribe({
      next: (updatedUser) => {
        this.ngZone.run(() => {
          this.currentUser = {
            ...this.currentUser,
            ...updatedUser,
            email: this.currentUser?.email || updatedUser.email,
          };
          
          this.authService.updateStatus(this.profileOnlineStatus).subscribe(res => {
            if (this.currentUser) {
              this.currentUser.status = res.status;
              this.cdr.detectChanges();
            }
          });
          
          if (this.currentPassword && this.newPassword) {
            if (this.newPassword !== this.confirmPassword) {
              alert('New passwords do not match!');
              this.profileSaving = false;
              this.cdr.detectChanges();
              return;
            }
            this.authService.changePassword(this.currentUser!.userId, {
              currentPassword: this.currentPassword,
              newPassword: this.newPassword,
              confirmPassword: this.confirmPassword
            }).subscribe({
              next: () => {
                this.profileSaving = false;
                this.showProfileModal = false;
                alert('Profile and password updated successfully!');
                this.cdr.detectChanges();
              },
              error: (err: any) => {
                this.profileSaving = false;
                alert('Profile updated, but failed to change password: ' + (err.error?.message || 'Unknown error'));
                this.cdr.detectChanges();
              }
            });
          } else {
            this.profileSaving = false;
            this.showProfileModal = false;
            this.cdr.detectChanges();
          }
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.profileSaving = false;
          alert('Failed to update profile.');
          this.cdr.detectChanges();
        });
      }
    });
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Read the value directly from the DOM element to avoid ngModel sync
      // timing issues where the model hasn't flushed yet at keydown time.
      const inputEl = event.target as HTMLInputElement;
      const currentValue = inputEl.value.trim();
      if (currentValue) {
        this.newMessage = currentValue;
      }
      this.sendMessage();
    }
  }

  // =========================================================================
  // Media Downloads
  // =========================================================================

  isDownloaded(messageId?: string): boolean {
    return !!messageId && this.downloadedFiles.has(messageId);
  }

  isDownloading(messageId?: string): boolean {
    return !!messageId && this.downloadingFiles.has(messageId);
  }

  markAsDownloaded(messageId?: string): void {
    if (!messageId || !this.currentUser) return;
    this.downloadedFiles.add(messageId);
    localStorage.setItem(`connecthub:v1:downloads:${this.currentUser.userId}`, JSON.stringify(Array.from(this.downloadedFiles)));
  }

  downloadMedia(msg: ChatMessage, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (!msg.mediaUrl || !msg.messageId) return;

    this.downloadingFiles.add(msg.messageId);

    const cleanUrlStr = this.cleanUrl(msg.mediaUrl)!;
    fetch(cleanUrlStr)
      .then(response => response.blob())
      .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = this.getFileNameFromMessage(msg) || 'download';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        this.downloadingFiles.delete(msg.messageId!);
        this.markAsDownloaded(msg.messageId!);
        this.cdr.detectChanges();
      })
      .catch(err => {
        console.error('Download failed', err);
        this.downloadingFiles.delete(msg.messageId!);
        this.cdr.detectChanges();
        alert('Failed to download file. It might be unavailable or network error.');
      });
  }

  // =========================================================================
  // Room Info Modal
  // =========================================================================

  openRoomInfo(): void {
    if (!this.selectedRoom) return;
    this.showRoomInfoModal = true;
    this.addMemberSearchTerm = '';
    this.addMemberSearchResults = [];
    this.loadRoomMembers();
  }

  closeRoomInfo(): void {
    this.showRoomInfoModal = false;
    this.addMemberSearchTerm = '';
    this.addMemberSearchResults = [];
  }

  loadRoomMembers(background = false): void {
    if (!this.selectedRoom) return;
    if (!background) this.roomInfoLoading = true;
    this.roomMembersWithDetails = [];
    
    this.roomService.getMembers(this.selectedRoom.roomId).subscribe({
      next: (members) => {
        this.ngZone.run(() => {
          this.roomMembersWithDetails = members.map(m => ({ ...m }));
          if (this.selectedRoom) {
            this.selectedRoom.memberCount = this.roomMembersWithDetails.length;
          }
          this.roomInfoLoading = false;
          this.cdr.detectChanges();
          
          // Fetch user details and presence for each member
          this.roomMembersWithDetails.forEach(member => {
            this.authService.getUserById(member.userId).subscribe({
              next: (u) => {
                this.ngZone.run(() => {
                  this.sanitizeUser(u);
                  member.user = u;
                  this.cdr.detectChanges();
                });
              },
              error: (err) => {
                if (err.status === 404) {
                  this.ngZone.run(() => {
                    // Retain the deleted user in the list as a tombstone
                    member.user = {
                      userId: member.userId,
                      username: 'deleted',
                      email: '',
                      fullName: 'Deleted User',
                      avatarUrl: '',
                      bio: '',
                      status: 'offline',
                      provider: 'LOCAL',
                      isActive: false,
                      isPrime: false
                    } as any;
                    member.onlineStatus = 'offline';
                    (member as any).lastSeenAt = null; // Remove last seen text
                    this.cdr.detectChanges();
                  });
                }
              }
            });
            this.presenceService.getStatus(member.userId).subscribe({
              next: (statusObj) => {
                this.ngZone.run(() => {
                  member.onlineStatus = statusObj.status;  // for the green/gray dot
                  (member as any).status = statusObj.status; // for last-seen display
                  const normalized = this.normalizeServerIso(statusObj.lastSeen) || null;
                  (member as any).lastSeenAt = normalized;
                  this.cdr.detectChanges();
                });

                // Silent fallback for environments where /status sometimes omits lastSeen.
                if (!statusObj.lastSeen && member.userId !== this.currentUser?.userId) {
                  this.presenceService.getLastSeen(member.userId).subscribe({
                    next: (ls) => {
                      this.ngZone.run(() => {
                        const normalized = this.normalizeServerIso(ls?.lastSeen) || null;
                        if (normalized) {
                          (member as any).lastSeenAt = normalized;
                          this.cdr.detectChanges();
                        }
                      });
                    },
                    error: () => {}
                  });
                }
              }
            });
          });
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.roomInfoLoading = false;
          this.cdr.detectChanges();
        });
      }
    });
  }

  searchMembersToAdd(): void {
    const query = this.addMemberSearchTerm.trim();
    if (query.length < 2) {
      this.addMemberSearchResults = [];
      return;
    }
    this.authService.searchUsers(query).subscribe({
      next: (users) => {
        // Filter out existing members and currentUser
        this.addMemberSearchResults = users.filter(u => 
          u.userId !== this.currentUser?.userId &&
          !this.roomMembersWithDetails.some(rm => rm.userId === u.userId)
        );
      }
    });
  }

  addUserFromModal(user: User): void {
    if (!this.selectedRoom) return;
    this.roomService.addMember(this.selectedRoom.roomId, user.userId).subscribe({
      next: () => {
        this.ngZone.run(() => {
          // Optimistically add to the modal list
          this.roomMembersWithDetails.push({
            userId: user.userId,
            role: 'MEMBER',
            joinedAt: new Date().toISOString(),
            lastReadAt: new Date().toISOString(),
            user: user
          });
          this.selectedRoom!.memberCount++;
          // Remove from search results
          this.addMemberSearchResults = this.addMemberSearchResults.filter(u => u.userId !== user.userId);
          this.addMemberSearchTerm = '';
          this.cdr.detectChanges();
        });
      },
      error: (err: any) => {
        this.ngZone.run(() => {
          alert(err.error?.message || 'Failed to add user to room');
          this.cdr.detectChanges();
        });
      }
    });
  }

  isOwnerOrAdmin(): boolean {
    if (!this.currentUser) return false;
    if (this.selectedRoom?.type === 'DIRECT') return true;
    const me = this.roomMembersWithDetails.find(m => m.userId === this.currentUser!.userId);
    return me?.role === 'OWNER' || me?.role === 'ADMIN';
  }

  isOwner(): boolean {
    if (!this.currentUser) return false;
    if (this.selectedRoom?.type === 'DIRECT') return true;
    const me = this.roomMembersWithDetails.find(m => m.userId === this.currentUser!.userId);
    return me?.role === 'OWNER';
  }

  isCurrentUserMuted(): boolean {
    if (!this.currentUser) return false;
    const me = this.roomMembersWithDetails.find(m => m.userId === this.currentUser!.userId);
    return !!me?.isMuted;
  }

  removeRoomMember(userId: string, userName?: string): void {
    if (!this.selectedRoom || !confirm(`Are you sure you want to remove ${userName || 'this user'}?`)) return;
    this.roomService.removeMember(this.selectedRoom.roomId, userId).subscribe({
      next: () => {
        this.ngZone.run(() => {
          this.roomMembersWithDetails = this.roomMembersWithDetails.filter(m => m.userId !== userId);
          this.selectedRoom!.memberCount--;
          this.cdr.detectChanges();
        });
      },
      error: (err) => alert(err.error?.message || 'Failed to remove user')
    });
  }

  changeRole(userId: string, newRole: string): void {
    if (!this.selectedRoom) return;
    this.roomService.changeMemberRole(this.selectedRoom.roomId, userId, newRole).subscribe({
      next: (updatedMember) => {
        this.ngZone.run(() => {
          const idx = this.roomMembersWithDetails.findIndex(m => m.userId === userId);
          if (idx !== -1) {
            this.roomMembersWithDetails[idx].role = updatedMember.role as any;
          }
          this.cdr.detectChanges();
        });
      },
      error: (err) => alert(err.error?.message || 'Failed to change role')
    });
  }

  toggleMute(userId: string, isMuted: boolean): void {
    if (!this.selectedRoom) return;
    this.roomService.muteMember(this.selectedRoom.roomId, userId, !isMuted).subscribe({
      next: (updatedMember) => {
        this.ngZone.run(() => {
          const idx = this.roomMembersWithDetails.findIndex(m => m.userId === userId);
          if (idx !== -1) {
            this.roomMembersWithDetails[idx].isMuted = updatedMember.isMuted;
          }
          this.cdr.detectChanges();
        });
      },
      error: (err) => alert(err.error?.message || 'Failed to toggle mute')
    });
  }

  leaveRoom(): void {
    if (!this.selectedRoom || !this.currentUser || !confirm(`Are you sure you want to leave ${this.selectedRoom.name}?`)) return;
    this.roomService.removeMember(this.selectedRoom.roomId, this.currentUser.userId).subscribe({
      next: () => {
        this.ngZone.run(() => {
          this.rooms = this.rooms.filter(r => r.roomId !== this.selectedRoom!.roomId);
          this.selectedRoom = null;
          this.closeRoomInfo();
          this.cdr.detectChanges();
        });
      },
      error: (err) => alert(err.error?.message || 'Failed to leave room')
    });
  }

  deleteRoom(): void {
    if (!this.selectedRoom || !confirm(`Are you sure you want to permanently delete ${this.selectedRoom.name}? This action cannot be undone.`)) return;
    this.roomService.deleteRoom(this.selectedRoom.roomId).subscribe({
      next: () => {
        this.ngZone.run(() => {
          this.rooms = this.rooms.filter(r => r.roomId !== this.selectedRoom!.roomId);
          this.selectedRoom = null;
          this.closeRoomInfo();
          this.showRoomSettingsModal = false;
          this.cdr.detectChanges();
        });
      },
      error: (err) => alert(err.error?.message || 'Failed to delete room')
    });
  }

  // =========================================================================
  // Room Settings & Invites
  // =========================================================================

  openRoomSettings(): void {
    if (!this.selectedRoom) return;
    
    // Use the details loaded when the Room Info modal was opened
    const me = this.roomMembersWithDetails.find(m => m.userId === this.currentUser?.userId);
    if (this.selectedRoom.type !== 'DIRECT' && me?.role === 'MEMBER') {
      alert('Only OWNER or ADMIN can edit room settings.');
      return;
    }

    this.roomSettingsName = this.selectedRoom.name;
    this.roomSettingsDesc = this.selectedRoom.description || '';
    this.roomSettingsAvatar = this.selectedRoom.avatarUrl || '';
    this.roomSettingsMaxMembers = this.selectedRoom.maxMemberLimit || null;
    this.showRoomInfoModal = false; // Hide info modal when opening settings
    this.showRoomSettingsModal = true;
  }

  saveRoomSettings(): void {
    if (!this.selectedRoom || !this.roomSettingsName.trim()) return;

    this.roomSettingsSaving = true;
    const request = {
      name: this.roomSettingsName,
      description: this.roomSettingsDesc,
      avatarUrl: this.roomSettingsAvatar,
      maxMemberLimit: this.roomSettingsMaxMembers
    };

    this.roomService.updateRoom(this.selectedRoom.roomId, request).subscribe({
      next: (updatedRoom) => {
        // Update local state
        const idx = this.rooms.findIndex(r => r.roomId === updatedRoom.roomId);
        if (idx !== -1) {
          this.rooms[idx] = { ...this.rooms[idx], ...updatedRoom };
          if (this.selectedRoom?.roomId === updatedRoom.roomId) {
            this.selectedRoom = this.rooms[idx];
          }
        }
        this.showRoomSettingsModal = false;
        this.roomSettingsSaving = false;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Failed to update room settings:', err);
        alert('Could not update room settings.');
        this.roomSettingsSaving = false;
      }
    });
  }

  copyInviteLink(): void {
    if (!this.selectedRoom?.inviteToken) return;
    const inviteText = this.selectedRoom.inviteToken;
    navigator.clipboard.writeText(inviteText).then(() => {
      alert('Invite token copied to clipboard!');
    }).catch(err => {
      console.error('Could not copy text: ', err);
    });
  }

  openJoinRoomModal(): void {
    this.joinToken = '';
    this.showJoinRoomModal = true;
  }

  joinRoom(): void {
    if (!this.joinToken.trim()) return;

    this.joiningRoom = true;
    this.roomService.joinRoomByToken(this.joinToken.trim()).subscribe({
      next: (room) => {
        alert('Successfully joined room: ' + room.name);
        this.showJoinRoomModal = false;
        this.joiningRoom = false;
        this.refreshRooms(); // Reload room list
        this.selectRoom(room);
      },
      error: (err: any) => {
        console.error('Failed to join room:', err);
        alert('Could not join room. Check if the token is valid or limit reached.');
        this.joiningRoom = false;
      }
    });
  }
  getInitials(name?: string | null): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
}
