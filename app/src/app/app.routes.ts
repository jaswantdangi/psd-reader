import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: 'harness', loadComponent: () => import('./harness/harness.page').then((m) => m.HarnessPage) },
  { path: '', redirectTo: 'harness', pathMatch: 'full' },
];
