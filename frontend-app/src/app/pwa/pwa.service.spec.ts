import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import { SwUpdate } from '@angular/service-worker';
import { Subject } from 'rxjs';

import { PwaService } from './pwa.service';

describe('PwaService', () => {
    const versionUpdates = new Subject<any>();
    const updates = {
        isEnabled: false,
        versionUpdates,
        checkForUpdate: vi.fn().mockName('checkForUpdate').mockResolvedValue(false),
        activateUpdate: vi.fn().mockName('activateUpdate').mockResolvedValue(true),
    };

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [{ provide: SwUpdate, useValue: updates }] });
        sessionStorage.clear();
        updates.isEnabled = false;
        updates.checkForUpdate.mockReset().mockResolvedValue(false);
        updates.activateUpdate.mockClear();
    });

    it('offers installation only after authentication and consumes the deferred prompt', async () => {
        const service = TestBed.inject(PwaService);
        const prompt = vi.fn().mockName('prompt').mockResolvedValue(undefined);
        const event = new Event('beforeinstallprompt') as Event & {
            prompt: () => Promise<void>;
            userChoice: Promise<{
                outcome: 'accepted';
            }>;
        };
        Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) });

        window.dispatchEvent(event);
        expect(service.canInstall).toBe(false);

        service.setAuthenticated(true);
        expect(service.canInstall).toBe(true);
        await service.install();

        expect(prompt).toHaveBeenCalled();
        expect(service.canInstall).toBe(false);
    });

    it('only activates an available update after an authenticated user selects it', async () => {
        updates.isEnabled = true;
        updates.activateUpdate.mockResolvedValue(false);
        const service = TestBed.inject(PwaService);
        versionUpdates.next({ type: 'VERSION_READY' });
        expect(service.updateAvailable).toBe(true);

        await service.applyUpdate();
        expect(updates.activateUpdate).not.toHaveBeenCalled();

        service.setAuthenticated(true);
        await service.applyUpdate();
        expect(updates.activateUpdate).toHaveBeenCalledTimes(1);
    });

    it('checks for an update and reloads the app when refresh is selected', async () => {
        updates.isEnabled = true;
        const reload = vi.fn();
        TestBed.overrideProvider(DOCUMENT, {useValue: {defaultView: {location: {reload}}}});
        const service = TestBed.inject(PwaService);
        service.setAuthenticated(true);

        await service.refreshApp();

        expect(updates.checkForUpdate).toHaveBeenCalledTimes(1);
        expect(updates.activateUpdate).not.toHaveBeenCalled();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('activates a discovered update before reloading', async () => {
        updates.isEnabled = true;
        updates.checkForUpdate.mockResolvedValue(true);
        const reload = vi.fn();
        TestBed.overrideProvider(DOCUMENT, {useValue: {defaultView: {location: {reload}}}});
        const service = TestBed.inject(PwaService);
        service.setAuthenticated(true);

        await service.refreshApp();

        expect(updates.activateUpdate).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('clears a live offline transition when the browser reports online', () => {
        const service = TestBed.inject(PwaService);

        window.dispatchEvent(new Event('offline'));
        expect(service.isOffline).toBe(true);
        expect(sessionStorage.getItem('zwei.pwa.offline')).toBe('true');
        expect(localStorage.getItem('zwei.pwa.offline')).toBeNull();

        window.dispatchEvent(new Event('online'));
        expect(service.isOffline).toBe(false);
        expect(sessionStorage.getItem('zwei.pwa.offline')).toBeNull();

        // HTTP responses continue to confirm connectivity as a separate path.
        window.dispatchEvent(new Event('offline'));
        service.confirmNetworkResponse();
        expect(service.isOffline).toBe(false);
        expect(sessionStorage.getItem('zwei.pwa.offline')).toBeNull();
    });

    it('preserves a reloaded offline indicator through repeated startup online signals', () => {
        sessionStorage.setItem('zwei.pwa.offline', 'true');

        const service = TestBed.inject(PwaService);

        expect(service.isOffline).toBe(true);
        window.dispatchEvent(new Event('online'));
        expect(service.isOffline).toBe(true);
        expect(sessionStorage.getItem('zwei.pwa.offline')).toBe('true');

        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('online'));
        expect(service.isOffline).toBe(true);
        expect(sessionStorage.getItem('zwei.pwa.offline')).toBe('true');

        service.confirmNetworkResponse();
        expect(service.isOffline).toBe(false);
        expect(sessionStorage.getItem('zwei.pwa.offline')).toBeNull();

        window.dispatchEvent(new Event('offline'));
        expect(service.isOffline).toBe(true);
        window.dispatchEvent(new Event('online'));
        expect(service.isOffline).toBe(false);
    });
});
