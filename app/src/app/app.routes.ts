import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: 'editor', loadComponent: () => import('./editor/editor.page').then((m) => m.EditorPage) },
  // The Phase 1 debug harness stays reachable, unchanged: it is the only place
  // the raw decode numbers are visible, and the editor deliberately does not
  // show them.
  { path: 'harness', loadComponent: () => import('./harness/harness.page').then((m) => m.HarnessPage) },
  { path: '', redirectTo: 'editor', pathMatch: 'full' },
];
