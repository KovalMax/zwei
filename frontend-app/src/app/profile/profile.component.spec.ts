import {ChangeDetectorRef} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {HostService} from '../auth/host.service';
import {BrowserNotificationService} from '../notifications/notification.service';
import {ProfileComponent} from './profile.component';
import {AppModule} from '../app.module';
import {PushEnrollmentService} from '../pwa/push-enrollment.service';

describe('ProfileComponent media preference', () => {
    const profile: Profile = {id: 'user-1', email: 'user@example.test', display_name: 'User', retention_period: '30d', auto_load_approved_media: false};
    let component: ProfileComponent;
    let auth: {updateProfile: ReturnType<typeof vi.fn>};

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [AppModule]}).compileComponents();
        auth = {updateProfile: vi.fn()};
        component = new ProfileComponent(auth as unknown as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef,
            {isAdminHost: () => false} as unknown as HostService, {} as BrowserNotificationService);
        component.profile = profile;
    });

    it('persists an explicit opt-in and adopts the saved account preference', () => {
        auth.updateProfile.mockReturnValue(of({...profile, auto_load_approved_media: true}));
        component.setMediaAutoLoad(true);
        expect(auth.updateProfile).toHaveBeenCalledWith({auto_load_approved_media: true});
        expect(component.profile?.auto_load_approved_media).toBe(true);
        expect(component.mediaSaving).toBe(false);
        expect(component.mediaSaveError).toBe(false);
    });

    it('restores the last persisted value after preference save fails', () => {
        auth.updateProfile.mockReturnValue(throwError(() => new Error('offline')));
        component.setMediaAutoLoad(true);
        expect(component.profile?.auto_load_approved_media).toBe(false);
        expect(component.mediaSaving).toBe(false);
        expect(component.mediaSaveError).toBe(true);
    });
});

describe('ProfileComponent alert preference', () => {
    const profile: Profile = {id: 'user-1', email: 'person@example.test', display_name: 'Person', retention_period: '30 days', auto_load_approved_media: false, alert_mode: 'notifications'};
    let auth: {profile: ReturnType<typeof vi.fn>; updateProfile: ReturnType<typeof vi.fn>};
    let notifications: {setMode: ReturnType<typeof vi.fn>; prepareCapabilities: ReturnType<typeof vi.fn>; unlockAudio: ReturnType<typeof vi.fn>};
    let component: ProfileComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [AppModule]}).compileComponents();
        auth = {profile: vi.fn(), updateProfile: vi.fn()};
        notifications = {setMode: vi.fn(), prepareCapabilities: vi.fn().mockResolvedValue('denied'), unlockAudio: vi.fn().mockResolvedValue(false)};
        component = new ProfileComponent(auth as unknown as AuthService, {markForCheck: vi.fn()} as unknown as ChangeDetectorRef, {isAdminHost: () => false} as HostService, notifications as unknown as BrowserNotificationService);
    });

    it('loads the saved server preference and applies it locally without reading browser storage', () => {
        auth.profile.mockReturnValue(of(profile));
        component.ngOnInit();
        expect(component.alertMode).toBe('notifications');
        expect(notifications.setMode).toHaveBeenCalledWith('notifications');
    });

    it('defaults a profile response from an older auth service to off', () => {
        const olderProfile: Profile = {id: 'user-1', email: 'person@example.test', display_name: 'Person', retention_period: '30 days', auto_load_approved_media: false};
        auth.profile.mockReturnValue(of(olderProfile));
        component.ngOnInit();
        expect(component.alertMode).toBe('off');
        expect(notifications.setMode).toHaveBeenCalledWith('off');
    });

    it('shows the profile load failure state without applying a local preference', () => {
        auth.profile.mockReturnValue(throwError(() => new Error('offline')));
        component.ngOnInit();
        expect(component.error).toBe(true);
        expect(component.alertMode).toBeUndefined();
        expect(notifications.setMode).not.toHaveBeenCalled();
    });

    it('persists the account preference even when local notification permission is denied', async () => {
        auth.updateProfile.mockReturnValue(of({...profile, alert_mode: 'notifications'}));
        component.alertMode = 'off';
        await component.setAlertMode('notifications');
        expect(auth.updateProfile).toHaveBeenCalledWith({alert_mode: 'notifications'});
        expect(component.alertMode).toBe('notifications');
        expect(notifications.setMode).toHaveBeenCalledWith('notifications');
        expect(notifications.prepareCapabilities).toHaveBeenCalledWith('notifications');
        expect(component.alertSaveError).toBe(false);
    });

    it('keeps the previous selected preference and reports a server save failure', async () => {
        auth.updateProfile.mockReturnValue(throwError(() => new Error('offline')));
        component.alertMode = 'off';
        await component.setAlertMode('sounds');
        expect(component.alertMode).toBe('off');
        expect(component.alertSaveError).toBe(true);
        expect(notifications.setMode).not.toHaveBeenCalled();
    });

    it('does not rewrite the server preference when local audio unlock fails', async () => {
        auth.updateProfile.mockReturnValue(of({...profile, alert_mode: 'sounds'}));
        component.alertMode = 'off';
        await component.setAlertMode('sounds');
        expect(component.alertMode).toBe('sounds');
        expect(notifications.prepareCapabilities).toHaveBeenCalledWith('sounds');
        expect(auth.updateProfile).toHaveBeenCalledTimes(1);
    });
});

describe('ProfileComponent enabled push presentation', () => {
    const profile: Profile = {id: 'user-1', email: 'person@example.test', display_name: 'Person', retention_period: '30 days', auto_load_approved_media: false, alert_mode: 'notifications'};
    let fixture: ComponentFixture<ProfileComponent>;
    let auth: {profile: ReturnType<typeof vi.fn>};
    let push: {state: string; enrollFromUserGesture: ReturnType<typeof vi.fn>};

    beforeEach(async () => {
        auth = {profile: vi.fn().mockReturnValue(of(profile))};
        push = {state: 'enabled', enrollFromUserGesture: vi.fn().mockResolvedValue(undefined)};
        await TestBed.configureTestingModule({
            imports: [AppModule],
            providers: [
                {provide: AuthService, useValue: auth},
                {provide: PushEnrollmentService, useValue: push},
                {provide: BrowserNotificationService, useValue: {setMode: vi.fn()}},
            ],
        }).compileComponents();
        fixture = TestBed.createComponent(ProfileComponent);
        fixture.componentInstance.profile = profile;
        fixture.componentInstance.alertMode = 'notifications';
        fixture.componentInstance.pushSuccess = true;
        fixture.detectChanges();
    });

    it('renders one enabled confirmation and keeps an accessible refresh action available', () => {
        const button = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
            .find(candidate => candidate.textContent?.includes('browser subscription'));
        const status = fixture.nativeElement.querySelectorAll('[role="status"]') as NodeListOf<HTMLElement>;

        expect(button?.textContent?.trim()).toBe('Refresh browser subscription');
        expect(button?.getAttribute('aria-label')).toBe('Refresh browser subscription');
        expect(button?.disabled).toBe(false);
        expect(Array.from(status).filter(message => message.textContent?.includes('Push notifications are enabled'))).toHaveLength(1);
    });

    it('uses the saving label while refreshing', async () => {
        const button = fixture.nativeElement.querySelector('button:not([role="radio"])') as HTMLButtonElement;
        expect(button.textContent?.trim()).toBe('Refresh browser subscription');
        expect(button.getAttribute('aria-label')).toBe('Refresh browser subscription');

        let finishEnrollment!: () => void;
        push.enrollFromUserGesture.mockReturnValue(new Promise<void>(resolve => { finishEnrollment = resolve; }));
        button.click();
        fixture.detectChanges();
        expect(button.textContent?.trim()).toBe('Enabling…');
        expect(button.getAttribute('aria-label')).toBe('Enabling…');
        expect(button.disabled).toBe(true);

        finishEnrollment();
        await fixture.whenStable();
        fixture.detectChanges();
    });

    it('shows actionable push-service timeout guidance and leaves retry available', async () => {
        push.enrollFromUserGesture.mockRejectedValueOnce(new Error('push-service-timeout'));
        fixture.nativeElement.querySelector('button:not([role="radio"])').click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('This browser’s push service did not respond');
        expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('Safari or Google Chrome');
        const retry = fixture.nativeElement.querySelector('button:not([role="radio"])') as HTMLButtonElement;
        expect(retry.disabled).toBe(false);
        expect(retry.textContent?.trim()).toBe('Refresh browser subscription');
    });
});

describe('ProfileComponent inline-media disclosure', () => {
    const profile: Profile = {id: 'user-1', email: 'person@example.test', display_name: 'Person', retention_period: '30 days', auto_load_approved_media: false, alert_mode: 'off'};
    let fixture: ComponentFixture<ProfileComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule],
            providers: [
                {provide: AuthService, useValue: {profile: vi.fn().mockReturnValue(of(profile))}},
                {provide: BrowserNotificationService, useValue: {setMode: vi.fn()}},
            ],
        }).compileComponents();
        fixture = TestBed.createComponent(ProfileComponent);
        fixture.componentInstance.profile = profile;
        fixture.detectChanges();
    });

    it('shows the complete disclosure from a keyboard-focusable info control without toggling the preference', async () => {
        const disclosure = 'When enabled, approved GIPHY images and GIFs in messages load automatically. Your browser contacts GIPHY, which may receive your IP address and request timing. Share-page links still require you to open GIPHY.';
        const conciseCopy = fixture.nativeElement.querySelector('.media-disclosure-row p')?.textContent?.trim();
        const preference = fixture.nativeElement.querySelector('.media-preference input') as HTMLInputElement;
        const infoButton = fixture.nativeElement.querySelector('button[aria-label="GIPHY loading privacy details"]') as HTMLButtonElement | null;

        expect(infoButton).not.toBeNull();
        expect(conciseCopy).toBe('Choose whether approved GIPHY media loads automatically in messages.');
        expect(infoButton?.type).toBe('button');
        expect(infoButton?.tabIndex).toBe(0);
        infoButton?.focus();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(document.body.textContent).toContain(disclosure);
        infoButton?.click();
        fixture.detectChanges();
        expect(preference.checked).toBe(false);
    });
});
