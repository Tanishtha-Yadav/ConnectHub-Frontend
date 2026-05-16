/** Room model matching room-service response */
export interface Room {
  roomId: string;
  name: string;
  description?: string;
  type: 'DIRECT' | 'GROUP' | 'CHANNEL';
  avatarUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  maxMemberLimit?: number;
  inviteToken?: string;
  memberCount: number;
  members?: RoomMember[];
  unreadCount?: number;
}

/** Room member */
export interface RoomMember {
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
  lastReadAt: string;
  isMuted?: boolean;
}

/** Create room request */
export interface CreateRoomRequest {
  name: string;
  description?: string;
  type: 'DIRECT' | 'GROUP' | 'CHANNEL';
  memberIds?: string[];
  maxMemberLimit?: number;
}

/** Update room request */
export interface UpdateRoomRequest {
  name?: string;
  description?: string;
  avatarUrl?: string;
  maxMemberLimit?: number;
}
