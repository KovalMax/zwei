import {ComponentFixture, TestBed} from '@angular/core/testing';

import {HeaderComponent} from './header.component';
import {AppModule} from '../../app.module';
import {AuthService} from '../../auth/auth.service';
import {Router} from '@angular/router';
import {Subject} from 'rxjs';
import {PushEnrollmentService} from '../../pwa/push-enrollment.service';

describe('HeaderComponent', () => {
    let component: HeaderComponent;
    let fixture: ComponentFixture<HeaderComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule]
        })
            .compileComponents();
    });

    beforeEach(() => {
        fixture = TestBed.createComponent(HeaderComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('uses the chat-bubble brand icon instead of a lettermark', () => {
        fixture.detectChanges();

        const brand = fixture.nativeElement.querySelector('.brand') as HTMLAnchorElement;
        const icon = brand.querySelector('.brand-mark') as HTMLImageElement;

        expect(icon.getAttribute('src')).toBe('assets/zwei-brand-mark.svg');
        expect(icon.getAttribute('alt')).toBe('');
        expect(brand.textContent?.trim()).toBe('zwei');
    });

    it('waits for server logout before best-effort local push unsubscribe and login navigation', async () => {
        const auth = TestBed.inject(AuthService);
        const push = TestBed.inject(PushEnrollmentService);
        const router = TestBed.inject(Router);
        const revoke = new Subject<void>();
        vi.spyOn(auth, 'logout').mockReturnValue(revoke.asObservable());
        const unsubscribe = vi.spyOn(push, 'unsubscribeLocal').mockResolvedValue();
        const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

        component.onLogout();
        expect(unsubscribe).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        revoke.next();
        revoke.complete();
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['login']));
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('leaves account menu placement to the Material trigger in mobile and desktop viewports', () => {
        const overlay = document.createElement('div');
        overlay.className = 'cdk-overlay-container';
        const panel = document.createElement('div');
        panel.className = 'mat-mdc-menu-panel';
        panel.style.setProperty('background-color', 'rgb(38, 53, 70)', 'important');
        overlay.append(panel);
        document.body.append(overlay);
        try {
            component.applyAccountMenuTheme();
            for (const property of ['position', 'top', 'right', 'bottom', 'left', 'transform']) {
                expect(panel.style.getPropertyValue(property), `${property} should remain controlled by Material`).toBe('');
            }

            component.onWindowResize();

            for (const property of ['position', 'top', 'right', 'bottom', 'left', 'transform']) {
                expect(panel.style.getPropertyValue(property), `${property} override should be cleared`).toBe('');
            }
            expect(panel.style.getPropertyValue('background-color')).toBe('rgb(38, 53, 70)');
        } finally {
            overlay.remove();
        }
    });
});
