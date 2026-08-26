import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
// Ionic 9 moved the standalone entry to the package root. There is no
// './standalone' subpath in its exports map, so the Ionic 8 import path
// fails to resolve and the app does not build.
import { provideIonicAngular } from '@ionic/angular';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideIonicAngular()
  ]
};
