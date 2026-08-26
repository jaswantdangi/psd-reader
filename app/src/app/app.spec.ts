import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('renders only a router outlet, so routed pages are not pushed off screen', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    // The generated welcome placeholder was removed: it set height:100dvh and
    // would have hidden the routed page below a full viewport on a phone.
    expect(compiled.querySelector('h1')).toBeNull();
    expect(compiled.querySelector('router-outlet')).toBeTruthy();
  });
});
