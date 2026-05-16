import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/**
 * MediaUploadResponse — matches the actual JSON returned by MediaController.
 * Backend returns: { key, url, presignedUrl, thumbnailUrl?, message }
 */
export interface MediaUploadResponse {
  key: string;
  url: string;
  presignedUrl: string;
  thumbnailUrl?: string;
  message?: string;
}

@Injectable({ providedIn: 'root' })
export class MediaService {
  private baseUrl = environment.apiGatewayUrl + '/api/media';

  constructor(private http: HttpClient) {}

  uploadImage(file: File, roomId: string, uploaderId: string): Observable<MediaUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'attachment');
    return this.http.post<MediaUploadResponse>(`${this.baseUrl}/upload`, formData);
  }

  uploadFile(file: File, roomId: string, uploaderId: string): Observable<MediaUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'attachment');
    return this.http.post<MediaUploadResponse>(`${this.baseUrl}/upload`, formData);
  }
}
