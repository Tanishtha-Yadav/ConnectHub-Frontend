// Polyfill for sockjs-client: browsers don't have Node's `global`
(window as any).global = window;

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app';

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
