import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ActivatedRoute} from '@angular/router';
import {of, Subject, throwError} from 'rxjs';
import {AppModule} from '../app.module';
import {AuthService} from '../auth/auth.service';
import {ActivationComponent} from './activation.component';

describe('ActivationComponent', () => {
    let fixture: ComponentFixture<ActivationComponent>;
    let component: ActivationComponent;
    const token = 'A'.repeat(43);

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule],
            providers: [{provide: ActivatedRoute, useValue: {snapshot: {queryParamMap: {get: () => null}}}}],
        }).compileComponents();
        history.replaceState(null, '', `/activate#setup=${token}`);
        fixture = TestBed.createComponent(ActivationComponent);
        component = fixture.componentInstance;
    });

    afterEach(() => history.replaceState(null, '', '/'));

    it('submits the fragment token with matching passwords, reports pending approval, and clears the fragment', () => {
        const auth = TestBed.inject(AuthService);
        const request = new Subject<{status: 'password_set'}>();
        const setup = vi.spyOn(auth, 'setupPassword').mockReturnValue(request);
        const acceptToken = vi.spyOn(auth, 'acceptToken');
        fixture.detectChanges();
        expect(component.setupToken).toBe(token);
        component.passwordForm.setValue({password: 'password123', confirmPassword: 'password123'});
        component.submitPassword();
        expect(component.isLoading).toBe(true);
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Saving your password');
        expect(setup).toHaveBeenCalledWith(token, 'password123');
        request.next({status: 'password_set'});
        request.complete();
        fixture.detectChanges();
        expect(component.passwordSet).toBe(true);
        expect(component.setupToken).toBeNull();
        expect(window.location.hash).toBe('');
        expect(fixture.nativeElement.textContent).toContain('sign in after an administrator approves');
        expect(fixture.nativeElement.textContent).not.toContain('account is active');
        expect(acceptToken).not.toHaveBeenCalled();
        expect(localStorage.getItem('zwei.intended-session')).toBeNull();
    });

    it('shows an unavailable state when setup fails and rejects fragment values of the wrong shape', () => {
        const auth = TestBed.inject(AuthService);
        vi.spyOn(auth, 'setupPassword').mockReturnValue(throwError(() => new Error('invalid token')));
        fixture.detectChanges();
        component.passwordForm.setValue({password: 'password123', confirmPassword: 'password123'});
        component.submitPassword();
        fixture.detectChanges();
        expect(component.error).toBe(true);
        expect(component.title).toBe('Password setup unavailable');

        history.replaceState(null, '', '/activate#setup=short');
        const invalidFixture = TestBed.createComponent(ActivationComponent);
        invalidFixture.detectChanges();
        expect(invalidFixture.componentInstance.error).toBe(true);
        expect(invalidFixture.nativeElement.textContent).toContain('Password setup unavailable');
        expect(invalidFixture.nativeElement.querySelector('form')).toBeNull();
        invalidFixture.destroy();
    });

    it('continues to expose the legacy query-token activation route', () => {
        const auth = TestBed.inject(AuthService);
        const route = TestBed.inject(ActivatedRoute);
        vi.spyOn(route.snapshot.queryParamMap, 'get').mockReturnValue('legacy-token');
        const activate = vi.spyOn(auth, 'activate').mockReturnValue(of({status: 'activated'}));
        fixture.detectChanges();
        expect(activate).toHaveBeenCalledWith('legacy-token');
        expect(component.activated).toBe(true);
        expect(component.setupMode).toBe(false);
    });
});
