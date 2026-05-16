import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Room, CreateRoomRequest, RoomMember } from '../models/room.model';

/**
 * RoomService — CRUD operations for rooms/channels via REST API.
 * All calls go through the API Gateway which routes to room-service.
 */
@Injectable({ providedIn: 'root' })
export class RoomService {

  private baseUrl = environment.rooms.baseUrl;

  constructor(private http: HttpClient) {}

  /** Get all rooms the authenticated user belongs to */
  getMyRooms(): Observable<Room[]> {
    return this.http.get<Room[]>(`${this.baseUrl}/my-rooms`);
  }

  /** Get room details by ID (includes member list) */
  getRoomById(roomId: string): Observable<Room> {
    return this.http.get<Room>(`${this.baseUrl}/${roomId}`);
  }

  /** Create a new room */
  createRoom(request: CreateRoomRequest): Observable<Room> {
    return this.http.post<Room>(this.baseUrl, request);
  }

  /** Get all members of a room */
  getMembers(roomId: string): Observable<RoomMember[]> {
    return this.http.get<RoomMember[]>(`${this.baseUrl}/${roomId}/members`);
  }

  /** Add a member to a room */
  addMember(roomId: string, userId: string, role: string = 'MEMBER'): Observable<RoomMember> {
    return this.http.post<RoomMember>(`${this.baseUrl}/${roomId}/members`, { userId, role });
  }

  /** Remove a member from a room */
  removeMember(roomId: string, userId: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/${roomId}/members/${userId}`);
  }

  /** Mark room as read (updates lastReadAt) */
  markAsRead(roomId: string): Observable<any> {
    return this.http.put(`${this.baseUrl}/${roomId}/read`, {});
  }

  /** Get or create a DM room with another user */
  getOrCreateDM(otherUserId: string): Observable<Room> {
    return this.http.post<Room>(`${this.baseUrl}/direct/${otherUserId}`, {});
  }

  /** Delete a room (OWNER only) */
  deleteRoom(roomId: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/${roomId}`);
  }

  /** Get all rooms on the platform (Admin) */
  getAllRooms(): Observable<Room[]> {
    return this.http.get<Room[]>(`${this.baseUrl}/all`);
  }

  /** Update room settings */
  updateRoom(roomId: string, request: any): Observable<Room> {
    return this.http.put<Room>(`${this.baseUrl}/${roomId}`, request);
  }

  /** Join a room via invite token */
  joinRoomByToken(token: string): Observable<Room> {
    return this.http.post<Room>(`${this.baseUrl}/join/${token}`, {});
  }

  /** Change a member's role (OWNER/ADMIN only) */
  changeMemberRole(roomId: string, userId: string, role: string): Observable<RoomMember> {
    return this.http.put<RoomMember>(`${this.baseUrl}/${roomId}/members/${userId}/role?role=${role}`, {});
  }

  /** Mute or unmute a member (OWNER/ADMIN only) */
  muteMember(roomId: string, userId: string, isMuted: boolean): Observable<RoomMember> {
    return this.http.put<RoomMember>(`${this.baseUrl}/${roomId}/members/${userId}/mute?isMuted=${isMuted}`, {});
  }
}
