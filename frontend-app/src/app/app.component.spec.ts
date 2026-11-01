import {TestBed} from '@angular/core/testing';
import {AppComponent} from './app.component';
import {AppModule} from './app.module';
import {PwaService} from './pwa/pwa.service';

describe('AppComponent', () => {
    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule],
        }).compileComponents();
    });

    it('should create the app', () => {
        const fixture = TestBed.createComponent(AppComponent);
        const app = fixture.componentInstance;
        expect(app).toBeTruthy();
    });

    it('keeps the offline recovery state in-flow as a polite warning notice', () => {
        const fixture = TestBed.createComponent(AppComponent);
        fixture.detectChanges();
        TestBed.inject(PwaService).offlineChanges.next(true);
        fixture.detectChanges();
        const notice = fixture.nativeElement.querySelector('app-notice [role="status"]') as HTMLElement;
        expect(notice.textContent).toContain('You’re offline. Zwei will reconnect when your connection returns.');
        expect(notice.getAttribute('aria-live')).toBe('polite');
        fixture.destroy();
    });

});
