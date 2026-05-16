import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './landing.component.html',
  styleUrls: ['./landing.component.css']
})
export class LandingComponent {
  features = [
    { icon: 'flash_on', title: 'Real-Time Messaging', desc: 'Instant delivery powered by WebSocket technology. Your messages arrive in milliseconds.' },
    { icon: 'lock', title: 'Secure & Private', desc: 'JWT-authenticated sessions and end-to-end encrypted connections keep your conversations safe.' },
    { icon: 'group', title: 'Group Channels', desc: 'Create rooms for your team, friends, or community with full admin controls.' },
    { icon: 'perm_media', title: 'Rich Media Sharing', desc: 'Share images, documents, and files seamlessly within any conversation.' },
    { icon: 'notifications_active', title: 'Smart Notifications', desc: 'Never miss a message. Get notified in real time across every device you use.' },
    { icon: 'star', title: 'Prime Membership', desc: 'Unlock exclusive features and a premium experience with ConnectHub Prime.' }
  ];

  constructor(private router: Router) {}

  goToLogin()    { this.router.navigate(['/login']); }
  goToRegister() { this.router.navigate(['/register']); }
}
