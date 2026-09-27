import {Component} from '@angular/core';
import {PwaService} from './pwa/pwa.service';

@Component({
    standalone: false,
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css']
})
export class AppComponent {
    public constructor(public readonly pwa: PwaService) {}
}
