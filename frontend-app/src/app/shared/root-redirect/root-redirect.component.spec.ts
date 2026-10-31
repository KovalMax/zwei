import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {vi} from 'vitest';
import {AppModule} from '../../app.module';
import {AuthService} from '../../auth/auth.service';
import {RootRedirectComponent} from './root-redirect.component';

describe('RootRedirectComponent', () => {
    it('announces session restoration while navigating to the default route', async () => {
        const router = {navigate: vi.fn().mockResolvedValue(true)};
        await TestBed.configureTestingModule({
            imports: [AppModule],
            providers: [
                {provide: AuthService, useValue: {defaultAuthenticatedRoute: () => 'home'}},
                {provide: Router, useValue: router},
            ],
        }).compileComponents();
        const fixture = TestBed.createComponent(RootRedirectComponent);
        fixture.detectChanges();

        expect(router.navigate).toHaveBeenCalledWith(['home']);
        const status: HTMLElement | null = fixture.nativeElement.querySelector('[role="status"]');
        expect(status?.getAttribute('aria-live')).toBe('polite');
        expect(status?.getAttribute('aria-atomic')).toBe('true');
        expect(status?.querySelector('.visually-hidden')?.textContent).toBe('Restoring session');
        expect(status?.querySelector('app-loading-spinner')?.getAttribute('aria-hidden')).toBe('true');
    });
});
