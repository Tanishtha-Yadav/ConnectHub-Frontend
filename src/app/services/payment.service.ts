import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface OrderResponse {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
}

export interface VerifyResponse {
  success: boolean;
  message: string;
}

@Injectable({
  providedIn: 'root'
})
export class PaymentService {
  private apiUrl = `${environment.apiGatewayUrl}/api/auth/payments`;

  constructor(private http: HttpClient) {}

  createOrder(plan: 'MONTHLY' | 'YEARLY'): Observable<OrderResponse> {
    return this.http.post<OrderResponse>(`${this.apiUrl}/create-order`, { plan });
  }

  verifyPayment(razorpayPaymentId: string, razorpayOrderId: string, razorpaySignature: string, plan: 'MONTHLY' | 'YEARLY'): Observable<VerifyResponse> {
    return this.http.post<VerifyResponse>(`${this.apiUrl}/verify`, {
      razorpayPaymentId,
      razorpayOrderId,
      razorpaySignature,
      plan
    });
  }
}
