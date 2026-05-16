/** Chat message matching STOMP payload and REST API response */
export interface ChatMessage {
  messageId?: string;
  roomId: string;
  senderId: string;
  senderName?: string;
  content: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  type?: string;
  replyToMessageId?: string;
  isEdited?: boolean;
  isDeleted?: boolean;
  isPinned?: boolean;
  deliveryStatus?: 'SENT' | 'DELIVERED' | 'READ';
  sentAt?: string;
  editedAt?: string;
  eventType?: 'CHAT' | 'TYPING' | 'READ' | 'REACTION' | 'EDIT' | 'DELETE' | 'PRESENCE_UPDATE' | 'DELIVERED' | 'PIN';
  targetMessageId?: string;
  reaction?: string;
  reactions?: { [emoji: string]: number }; // Emoji -> count map
  timestamp?: string;
  
  // Presence Update fields
  isOnline?: boolean;
  lastSeenAt?: string;
  status?: string;
}

/** Paginated response from the message-service REST API */
export interface PagedMessages {
  content: ChatMessage[];
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
  last: boolean;
}
