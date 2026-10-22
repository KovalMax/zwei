import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import { SwUpdate } from '@angular/service-worker';
import { Subject } from 'rxjs';

import { PwaService } from './pwa.service';

async function withBadgeAPIs<T>(setAppBadge: unknown, clearAppBadge: unknown, run: () => Promise<T>): Promise<T> {
    const descriptors = new Map(['setAppBadge', 'clearAppBadge'].map(name => [name, Object.getOwnPropertyDescriptor(navigator, name)]));
    try {
        Object.defineProperties(navigator, {
            setAppBadge: {configurable: true, value: setAppBadge},
            clearAppBadge: {configurable: true, value: clearAppBadge},
        });
        return await run();
    } finally {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(navigator, name, descriptor);
            else delete (navigator as unknown as Record<string, unknown>)[name];
        }
    }
}

async function settleBadgeOperations(): Promise<void> {
    for (let index = 0; index < 8; index++) await Promise.resolve();
}

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

    it('mirrors aggregate unread counts only while authenticated and clears on sign-out', async () => {
        const setAppBadge = vi.fn().mockResolvedValue(undefined);
        const clearAppBadge = vi.fn().mockResolvedValue(undefined);
        await withBadgeAPIs(setAppBadge, clearAppBadge, async () => {
            const service = TestBed.inject(PwaService);

            service.setUnreadCount(3);
            expect(setAppBadge).not.toHaveBeenCalled();
            service.setAuthenticated(true);
            await settleBadgeOperations();
            expect(setAppBadge).not.toHaveBeenCalled();
            service.setUnreadCount(5);
            await settleBadgeOperations();
            expect(setAppBadge).toHaveBeenLastCalledWith(5);
            service.setUnreadCount(0);
            await settleBadgeOperations();
            expect(clearAppBadge).toHaveBeenCalledTimes(2);
            service.setUnreadCount(2);
            service.setAuthenticated(false);
            await settleBadgeOperations();
            expect(clearAppBadge).toHaveBeenCalledTimes(3);
            expect(setAppBadge).toHaveBeenCalledTimes(2);
        });
    });

    it('restores navigator badge descriptors after successful and throwing callbacks', async () => {
        const originalSetDescriptor = Object.getOwnPropertyDescriptor(navigator, 'setAppBadge');
        const originalClearDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clearAppBadge');
        const originalSet = navigator.setAppBadge;
        const originalClear = navigator.clearAppBadge;

        await withBadgeAPIs(vi.fn(), vi.fn(), async () => {
            expect(navigator.setAppBadge).not.toBe(originalSet);
            expect(navigator.clearAppBadge).not.toBe(originalClear);
        });
        expect(Object.getOwnPropertyDescriptor(navigator, 'setAppBadge')).toEqual(originalSetDescriptor);
        expect(Object.getOwnPropertyDescriptor(navigator, 'clearAppBadge')).toEqual(originalClearDescriptor);
        expect(navigator.setAppBadge).toBe(originalSet);
        expect(navigator.clearAppBadge).toBe(originalClear);

        const failure = new Error('test callback failed');
        await expect(withBadgeAPIs(vi.fn(), vi.fn(), async () => { throw failure; })).rejects.toBe(failure);
        expect(Object.getOwnPropertyDescriptor(navigator, 'setAppBadge')).toEqual(originalSetDescriptor);
        expect(Object.getOwnPropertyDescriptor(navigator, 'clearAppBadge')).toEqual(originalClearDescriptor);
        expect(navigator.setAppBadge).toBe(originalSet);
        expect(navigator.clearAppBadge).toBe(originalClear);
    });

    it('tolerates unsupported and rejected badge APIs', async () => {
        const service = TestBed.inject(PwaService);
        service.setAuthenticated(true);
        service.setUnreadCount(1);
        expect(() => service.setUnreadCount(0)).not.toThrow();

        await withBadgeAPIs(vi.fn().mockRejectedValue(new Error('unsupported')), vi.fn().mockRejectedValue(new Error('unsupported')), async () => {
            expect(() => service.setUnreadCount(4)).not.toThrow();
            service.setAuthenticated(false);
            await settleBadgeOperations();
        });
    });

    it('resets unread state between accounts and serializes stale badge operations', async () => {
        const setResolutions: (() => void)[] = [];
        const clearResolutions: (() => void)[] = [];
        const setAppBadge = vi.fn(() => new Promise<void>(resolve => setResolutions.push(resolve)));
        const clearAppBadge = vi.fn(() => new Promise<void>(resolve => clearResolutions.push(resolve)));

        await withBadgeAPIs(setAppBadge, clearAppBadge, async () => {
            const service = TestBed.inject(PwaService);
            service.setAuthenticated(true);
            expect(clearAppBadge).toHaveBeenCalledTimes(1);
            clearResolutions[0]();
            await settleBadgeOperations();

            service.setUnreadCount(7);
            expect(setAppBadge).toHaveBeenCalledWith(7);
            service.setAuthenticated(false);
            service.setUnreadCount(12);
            service.setAuthenticated(true);
            expect(clearAppBadge).toHaveBeenCalledTimes(1);

            setResolutions[0]();
            await settleBadgeOperations();
            expect(clearAppBadge).toHaveBeenCalledTimes(2);
            expect(setAppBadge).toHaveBeenCalledTimes(1);
            clearResolutions[1]();
            await settleBadgeOperations();

            service.setUnreadCount(2);
            expect(setAppBadge).toHaveBeenLastCalledWith(2);
            setResolutions[1]();
            await settleBadgeOperations();
        });
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
