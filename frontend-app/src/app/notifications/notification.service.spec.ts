import type { MockedObject } from "vitest";
import { BrowserNotificationPort, BrowserNotificationService, SoundPort } from './notification.service';

describe('BrowserNotificationService', () => {
    let browser: MockedObject<BrowserNotificationPort>;
    let sound: MockedObject<SoundPort>;
    let service: BrowserNotificationService;

    beforeEach(() => {
        browser = {
            requestPermission: vi.fn().mockName("browser.requestPermission"),
            show: vi.fn().mockName("browser.show"),
            supported: true, permission: 'default'
        };
        sound = {
            unlock: vi.fn().mockName("sound.unlock"),
            playMessage: vi.fn().mockName("sound.playMessage"),
            startCall: vi.fn().mockName("sound.startCall"),
            stopCall: vi.fn().mockName("sound.stopCall")
        };
        sound.unlock.mockResolvedValue(true);
        browser.requestPermission.mockResolvedValue('granted');
        service = new BrowserNotificationService(browser, sound);
    });

    afterEach(() => service.setMode('off'));

    it('requests permission and unlocks sounds from the explicit user action', async () => {
        service.setMode('notifications');
        await service.prepareCapabilities('notifications');

        expect(browser.requestPermission).toHaveBeenCalledTimes(1);

        expect(browser.requestPermission).toHaveBeenCalledWith();
        expect(sound.unlock).toHaveBeenCalledTimes(1);
        expect(sound.unlock).toHaveBeenCalledWith();
        expect(service.notificationPermission).toBe('granted');
        expect(service.areSoundsEnabled).toBe(true);
    });

    it('shows privacy-safe message and call notifications only after permission', async () => {
        service.setMode('notifications');
        await service.prepareCapabilities('notifications');

        service.showMessageNotification('conversation-1');
        service.showCallNotification('call-1');

        expect(browser.show).toHaveBeenCalledWith('New message', { body: 'You have a new message.', tag: 'zwei-message-conversation-1' });
        expect(browser.show).toHaveBeenCalledWith('Incoming call', { body: 'You have an incoming audio call.', tag: 'zwei-call-call-1' });
    });

    it('keeps the selected account mode when browser notifications are denied', async () => {
        browser.requestPermission.mockResolvedValue('denied');

        service.setMode('notifications');
        await service.prepareCapabilities('notifications');
        service.showMessageNotification('conversation-1');
        service.playMessageSound();

        expect(service.notificationPermission).toBe('denied');
        expect(service.mode).toBe('notifications');
        expect(service.areSoundsEnabled).toBe(true);
        expect(browser.show).not.toHaveBeenCalled();
        expect(sound.playMessage).toHaveBeenCalledTimes(1);
        expect(sound.playMessage).toHaveBeenCalledWith();
    });

    it('does not change the saved mode when local audio cannot unlock', async () => {
        sound.unlock.mockResolvedValue(false);
        service.setMode('sounds');
        await service.unlockAudio();
        expect(service.mode).toBe('sounds');
    });

    it('registers a later audio-unlock gesture when the profile loads after an earlier interaction', async () => {
        window.dispatchEvent(new Event('pointerdown'));
        expect(sound.unlock).not.toHaveBeenCalled();

        service.setMode('sounds');
        window.dispatchEvent(new Event('pointerdown'));
        await vi.waitFor(() => expect(sound.unlock).toHaveBeenCalledTimes(1));
    });

    it('does not request notification permission when unsupported', async () => {
        Object.defineProperty(browser, 'supported', {value: false});
        service.setMode('notifications');
        await service.prepareCapabilities('notifications');
        expect(browser.requestPermission).not.toHaveBeenCalled();
        expect(service.mode).toBe('notifications');
        expect(service.notificationPermission).toBe('default');
    });
});
