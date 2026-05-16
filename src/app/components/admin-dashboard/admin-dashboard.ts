import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { forkJoin } from 'rxjs';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { RoomService } from '../../services/room.service';
import { AdminService } from '../../services/admin.service';
import { PresenceService } from '../../services/presence.service';
import { User } from '../../models/user.model';
import { Room } from '../../models/room.model';

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-dashboard.html',
  styleUrl: './admin-dashboard.css',
})
export class AdminDashboard implements OnInit, OnDestroy {

  currentUser: User | null = null;
  activeTab: 'overview' | 'users' | 'rooms' | 'broadcast' | 'audit' = 'overview';

  // Users
  allUsers: User[] = [];
  filteredUsers: User[] = [];
  usersLoading = false;
  userSearchTerm = '';

  // Rooms
  allRooms: Room[] = [];
  filteredRooms: Room[] = [];
  roomsLoading = false;
  roomSearchTerm = '';
  roomAdminIds = new Set<string>();

  // Audit Logs
  auditLogs: any[] = [];
  logsLoading = false;

  // Broadcast
  broadcast = {
    title: '',
    message: '',
    type: 'INFO' as 'INFO' | 'WARNING' | 'ALERT'
  };
  broadcastSending = false;

  // Analytics
  stats: any = {
    totalUsers: 0,
    activeUsers: 0,
    totalRooms: 0,
    directRooms: 0,
    groupRooms: 0,
    channelRooms: 0,
    onlineUsers: 0,
    totalMessages: 0,
    messagesPerDay: 0,
    fileStorageUsedBytes: 0,
    activeConnections: 0
  };
  analyticsLoading = false;

  // Auto-refresh interval for real-time WebSocket connection count
  private analyticsInterval: ReturnType<typeof setInterval> | null = null;
  private readonly ANALYTICS_POLL_MS = 30_000; // 30 seconds

  constructor(
    private authService: AuthService,
    private roomService: RoomService,
    private adminService: AdminService,
    private presenceService: PresenceService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.currentUser = this.authService.getCurrentUser();

    // Redirect if not admin
    if (!this.currentUser || this.currentUser.role !== 'ROLE_ADMIN') {
      this.router.navigate(['/chat']);
      return;
    }

    // Set platform admin online
    if (this.currentUser.userId) {
      this.presenceService.setOnline(this.currentUser.userId).subscribe();
    }

    this.loadAll();
    // Start polling immediately — Overview is the default active tab
    this.startAnalyticsPolling();
  }

  loadAll(): void {
    this.loadAnalytics();
    this.loadUsers();
    this.loadRooms();
    this.loadAuditLogs();
  }

  private startAnalyticsPolling(): void {
    this.stopAnalyticsPolling();
    this.analyticsInterval = setInterval(() => this.loadAnalytics(), this.ANALYTICS_POLL_MS);
  }

  private stopAnalyticsPolling(): void {
    if (this.analyticsInterval !== null) {
      clearInterval(this.analyticsInterval);
      this.analyticsInterval = null;
    }
  }

  ngOnDestroy(): void {
    this.stopAnalyticsPolling();
    
    // Disconnect presence if leaving the app entirely (though they usually go to chat)
    // Actually, setting offline here might interfere if they go back to chat. 
    // Chat component handles its own presence.
  }

  loadAnalytics(): void {
    this.analyticsLoading = true;
    this.adminService.getAnalytics().subscribe({
      next: (data: any) => {
        this.stats = { ...this.stats, ...data };
        // Fix: Do not count direct messages in active rooms
        this.stats.activeRooms = (this.stats.groupRooms || 0) + (this.stats.channelRooms || 0);
        this.analyticsLoading = false;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Failed to load analytics', err);
        this.analyticsLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadUsers(): void {
    this.usersLoading = true;
    this.authService.getAllUsers().subscribe({
      next: (users: User[]) => {
        this.allUsers = users;
        this.filteredUsers = users;
        this.usersLoading = false;
        this.cdr.detectChanges();
        
        // Fetch real-time online status and update active connections
        this.presenceService.getOnlineUsers().subscribe({
          next: (onlineUserIds) => {
            this.allUsers.forEach(u => {
              if (u.userId) {
                u.status = onlineUserIds.includes(u.userId) ? 'online' : 'offline';
              }
            });
            this.stats.activeConnections = this.allUsers.filter(x => x.status === 'online').length;
            this.cdr.detectChanges();
          },
          error: () => this.cdr.detectChanges()
        });
      },
      error: (err: any) => {
        console.error('Failed to load users', err);
        this.usersLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadRooms(): void {
    this.roomsLoading = true;
    this.roomService.getAllRooms().subscribe({
      next: (rooms: Room[]) => {
        this.allRooms = rooms;
        this.filteredRooms = rooms;
        this.roomsLoading = false;

        // Find all global room admins
        const requests = rooms.map(r => this.roomService.getMembers(r.roomId));
        if (requests.length > 0) {
          forkJoin(requests).subscribe(results => {
            const admins = new Set<string>();
            results.forEach(members => {
              members.forEach(m => {
                if (m.role === 'ADMIN') {
                  admins.add(m.userId);
                }
              });
            });
            this.roomAdminIds = admins;
            this.cdr.detectChanges();
          });
        }

        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Failed to load rooms', err);
        this.roomsLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadAuditLogs(): void {
    this.logsLoading = true;
    this.adminService.getAuditLogs().subscribe({
      next: (logs: any[]) => {
        // Fix wrong timing of logs by ensuring UTC interpretation
        this.auditLogs = logs.map(log => {
          if (log.timestamp) {
            if (Array.isArray(log.timestamp)) {
              const [y, m, d, h, min, s] = log.timestamp;
              const pad = (n: number) => (n || 0).toString().padStart(2, '0');
              log.timestamp = `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}Z`;
            } else if (typeof log.timestamp === 'string' && !log.timestamp.endsWith('Z') && !log.timestamp.includes('+')) {
              log.timestamp += 'Z';
            }
          }
          return log;
        });
        this.logsLoading = false;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Failed to load audit logs', err);
        this.logsLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  // User Actions
  suspendUser(user: User): void {
    if (confirm(`Are you sure you want to suspend ${user.username}?`)) {
      this.adminService.suspendUser(user.userId!).subscribe({
        next: () => {
          this.logAdminAction('SUSPEND_USER', user.userId!, `Suspended user ${user.username}`);
          this.loadUsers();
        }
      });
    }
  }

  reactivateUser(user: User): void {
    this.adminService.reactivateUser(user.userId!).subscribe({
      next: () => {
        this.logAdminAction('REACTIVATE_USER', user.userId!, `Reactivated user ${user.username}`);
        this.loadUsers();
      }
    });
  }

  deleteUser(user: User): void {
    if (confirm(`PERMANENTLY delete user ${user.username}? This cannot be undone.`)) {
      this.adminService.deleteUser(user.userId!).subscribe({
        next: () => {
          this.logAdminAction('DELETE_USER', user.userId!, `Permanently deleted user ${user.username}`);
          this.loadUsers();
        }
      });
    }
  }

  // Room Actions
  deleteRoom(room: Room): void {
    if (confirm(`Delete room "${room.name}"?`)) {
      this.adminService.deleteRoom(room.roomId!).subscribe({
        next: () => {
          this.logAdminAction('DELETE_ROOM', room.roomId!, `Deleted room ${room.name}`);
          this.loadRooms();
        }
      });
    }
  }

  // Broadcast
  sendBroadcast(): void {
    if (!this.broadcast.title || !this.broadcast.message) return;
    this.broadcastSending = true;
    this.adminService.broadcastMessage(this.broadcast).subscribe({
      next: () => {
        this.logAdminAction('SEND_BROADCAST', 'PLATFORM', `Sent broadcast: ${this.broadcast.title}`);
        alert('Broadcast sent successfully!');
        this.broadcast = { title: '', message: '', type: 'INFO' };
        this.broadcastSending = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.broadcastSending = false;
        this.cdr.detectChanges();
      }
    });
  }

  private logAdminAction(action: string, targetId: string, details: string): void {
    if (!this.currentUser) return;
    this.adminService.createAuditLog({
      adminId: this.currentUser.userId,
      adminName: this.currentUser.username,
      action,
      targetId,
      details
    }).subscribe();
  }

  filterUsers(): void {
    const q = this.userSearchTerm.toLowerCase();
    this.filteredUsers = this.allUsers.filter(u =>
      u.username?.toLowerCase().includes(q) ||
      u.fullName?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q)
    );
  }

  filterRooms(): void {
    const q = this.roomSearchTerm.toLowerCase();
    this.filteredRooms = this.allRooms.filter(r =>
      r.name?.toLowerCase().includes(q) ||
      r.type?.toLowerCase().includes(q)
    );
  }

  setTab(tab: 'overview' | 'users' | 'rooms' | 'broadcast' | 'audit'): void {
    this.activeTab = tab;
    if (tab === 'audit') this.loadAuditLogs();
    if (tab === 'overview') {
      this.loadAnalytics();
      this.startAnalyticsPolling();
    } else {
      // Stop polling when not on overview to save requests
      this.stopAnalyticsPolling();
    }
  }

  backToChat(): void {
    this.router.navigate(['/chat']);
  }

  getUserInitial(user: User): string {
    return (user.fullName || user.username || 'U').charAt(0).toUpperCase();
  }

  getRoomIcon(type: string): string {
    switch (type) {
      case 'DIRECT': return 'person';
      case 'GROUP': return 'group';
      case 'CHANNEL': return 'tag';
      default: return 'chat';
    }
  }

  getStatusClass(status: string): string {
    if (!status) return 'status-offline';
    switch (status.toLowerCase()) {
      case 'online': return 'status-online';
      case 'away': return 'status-away';
      case 'invisible': return 'status-invisible';
      default: return 'status-offline';
    }
  }

  getRoleBadge(user: User): string {
    if (user.role === 'ROLE_ADMIN') return 'Owner';
    return 'User';
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

