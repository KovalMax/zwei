import {ChangeDetectorRef} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {HostService} from '../auth/host.service';
import {BrowserNotificationService} from '../notifications/notification.service';
import {ProfileComponent} from './profile.component';
import {AppModule} from '../app.module';

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
