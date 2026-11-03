import type {Token} from './token';

export interface BrowserSessionSelector {
    browser_id: string;
    generation: string;
}

export interface ContinuedBrowserSession extends BrowserSessionSelector, Token {}
