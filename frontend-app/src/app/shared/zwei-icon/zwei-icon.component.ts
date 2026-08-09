import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';

export type ZweiIconName =
    | 'arrow_back'
    | 'arrow_forward'
    | 'badge'
    | 'call'
    | 'cloud_off'
    | 'dark_mode'
    | 'done_all'
    | 'forum'
    | 'hourglass_top'
    | 'light_mode'
    | 'lock'
    | 'lock_confirm'
    | 'lock_reset'
    | 'logout'
    | 'mail'
    | 'mark_chat_unread'
    | 'person'
    | 'search'
    | 'send'
    | 'sync';

const ICON_PATHS: Record<ZweiIconName, string> = {
    arrow_back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    arrow_forward: 'm12 4-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z',
    badge: 'M20 5h-3.17L15 3H9L7.17 5H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-8 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm4 10H8v-1c0-1.33 2.67-2 4-2s4 .67 4 2v1z',
    call: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.32.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
    cloud_off: 'm21.9 20.49-3.58-3.58c.68-.58 1.17-1.37 1.35-2.29C21.07 14.22 22 13.03 22 11.5c0-1.69-1.14-3.14-2.77-3.57C18.73 5.08 16.14 3 13 3c-1.36 0-2.6.4-3.66 1.07L2.39 1.12 1.12 2.39 20.63 21.9l1.27-1.41zM3.27 5.15l1.55 1.55C3.74 7.33 3 8.58 3 10c0 1.86 1.28 3.41 3 3.86V14c0 2.21 1.79 4 4 4h4.14l-2-2H10c-1.1 0-2-.9-2-2v-2H7c-1.1 0-2-.9-2-2 0-.86.54-1.59 1.31-1.88L3.27 5.15z',
    dark_mode: 'M9.37 5.51A7.5 7.5 0 0 0 18.49 14.63 7.5 7.5 0 1 1 9.37 5.51z',
    done_all: 'M18 7l-1.41-1.41L10 12.17 7.41 9.59 6 11l4 4 8-8zm-5.5 8.5-1.41-1.41-1.42 1.41L12.5 17.32 22 7.82 20.59 6.41l-8.09 8.09z',
    forum: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 11H4V9h2v2zm4 0H8V9h2v2zm4 0h-2V9h2v2zm4 0h-2V9h2v2z',
    hourglass_top: 'M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L14 12l4-3.99V2H6zm10 14.5V20H8v-3.5l4-4 4 4zM12 11.5l-4-4V4h8v3.5l-4 4z',
    light_mode: 'M12 4a1 1 0 0 1-1-1V1h2v2a1 1 0 0 1-1 1zm0 16a1 1 0 0 1 1 1v2h-2v-2a1 1 0 0 1 1-1zM4 12a1 1 0 0 1-1 1H1v-2h2a1 1 0 0 1 1 1zm16 0a1 1 0 0 1 1-1h2v2h-2a1 1 0 0 1-1-1zM6.34 7.76 4.93 6.34l1.41-1.41 1.42 1.41-1.42 1.42zm11.32 11.31-1.42-1.41 1.42-1.42 1.41 1.42-1.41 1.41zM17.66 7.76l-1.42-1.42 1.42-1.41 1.41 1.41-1.41 1.42zM7.76 19.07l-1.42-1.41-1.41 1.41 1.41 1.42 1.42-1.42zM12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
    lock_confirm: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9.5-3-3 1.41-1.41L12 14.67l3.59-3.58L17 12.5l-5 5zM15.1 8H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
    lock_reset: 'M12 1a7 7 0 0 0-7 7h2a5 5 0 1 1 1.46 3.54L7 13h5V8l-1.9 1.9A3 3 0 1 0 9 8H7a5 5 0 1 1 5 5 7 7 0 1 0 0-14zm-7 14v7h14v-7H5zm7 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
    logout: 'M10 17v-2h4V9h-4V7l-5 5 5 5zm9-14H9c-1.1 0-2 .9-2 2v4h2V5h10v14H9v-4H7v4c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z',
    mail: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z',
    mark_chat_unread: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 14H6l-2 2V4h16v12zm-4-5c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z',
    person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    search: 'M9.5 3a6.5 6.5 0 0 1 5.2 10.4L21 19.7 19.7 21l-6.3-6.3A6.5 6.5 0 1 1 9.5 3zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
    send: 'm2.01 21L23 12 2.01 3 2 10l15 2-15 2 .01 7z',
    sync: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.96-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm-6.76 3.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6 0-1.01.25-1.96.7-2.8L5.24 7.74z',
};

@Component({
    selector: 'zwei-icon',
    standalone: false,
    template: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path [attr.d]="path()"/></svg>',
    styles: [':host { display: inline-flex; width: 24px; height: 24px; flex: 0 0 24px; align-items: center; justify-content: center; line-height: 1; } svg { width: 100%; height: 100%; fill: currentColor; }'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {'aria-hidden': 'true', class: 'mat-icon'},
})
export class ZweiIconComponent {
    readonly name = input.required<ZweiIconName>();
    protected readonly path = computed(() => ICON_PATHS[this.name()]);
}
