import {BrowserNotificationPort, BrowserNotificationService, SoundPort} from './notification.service';

describe('BrowserNotificationService', () => {
    let browser: jasmine.SpyObj<BrowserNotificationPort>;
    let sound: jasmine.SpyObj<SoundPort>;
    let service: BrowserNotificationService;

    beforeEach(() => {
        browser = jasmine.createSpyObj<BrowserNotificationPort>('browser', ['requestPermission', 'show'], {supported: true, permission: 'default'});
        sound = jasmine.createSpyObj<SoundPort>('sound', ['unlock', 'playMessage', 'startCall', 'stopCall']);
        sound.unlock.and.resolveTo(true);
        browser.requestPermission.and.resolveTo('granted');
        service = new BrowserNotificationService(browser, sound);
    });

    it('requests permission and unlocks sounds from the explicit user action', async () => {
        await service.enable();

        expect(browser.requestPermission).toHaveBeenCalledOnceWith();
        expect(sound.unlock).toHaveBeenCalledOnceWith();
        expect(service.notificationPermission).toBe('granted');
        expect(service.areSoundsEnabled).toBeTrue();
    });

    it('shows privacy-safe message and call notifications only after permission', async () => {
        await service.enable();

        service.showMessageNotification('conversation-1');
        service.showCallNotification('call-1');

        expect(browser.show).toHaveBeenCalledWith('New message', {body: 'You have a new message.', tag: 'zwei-message-conversation-1'});
        expect(browser.show).toHaveBeenCalledWith('Incoming call', {body: 'You have an incoming audio call.', tag: 'zwei-call-call-1'});
    });

    it('keeps sounds available when browser notifications are denied', async () => {
        browser.requestPermission.and.resolveTo('denied');

        await service.enable();
        service.showMessageNotification('conversation-1');
        service.playMessageSound();

        expect(service.notificationPermission).toBe('denied');
        expect(service.areSoundsEnabled).toBeTrue();
        expect(browser.show).not.toHaveBeenCalled();
        expect(sound.playMessage).toHaveBeenCalledOnceWith();
    });
});
