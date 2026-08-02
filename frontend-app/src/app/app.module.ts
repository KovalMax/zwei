import {BrowserModule} from '@angular/platform-browser';
import {NgModule} from '@angular/core';
import {AppRoutingModule} from './app-routing.module';
import {AppComponent} from './app.component';
import {BrowserAnimationsModule} from '@angular/platform-browser/animations';
import {AppMaterialModule} from './app-material.module';
import {FormsModule, ReactiveFormsModule} from '@angular/forms';
import {HeaderComponent} from './navigation/header/header.component';
import {HomeComponent} from './home/home.component';
import {LoginComponent} from './login/login.component';
import {RegistrationComponent} from './registration/registration.component';
import {HTTP_INTERCEPTORS, HttpClientModule} from '@angular/common/http';
import {AuthService} from './auth/auth.service';
import {TokenStorageService} from './auth/token-storage.service';
import {AuthInterceptorService} from './auth/auth-interceptor.service';
import {LoadingSpinnerComponent} from './shared/loading-spinner/loading-spinner.component';
import {RegistrationService} from './registration/registration.service';

@NgModule({
    declarations: [
        AppComponent,
        HeaderComponent,
        HomeComponent,
        LoginComponent,
        RegistrationComponent,
        LoadingSpinnerComponent,
    ],
    imports: [
        BrowserModule,
        BrowserAnimationsModule,
        AppRoutingModule,
        AppMaterialModule,
        FormsModule,
        ReactiveFormsModule,
        HttpClientModule,
    ],
    providers: [
        RegistrationService,
        TokenStorageService,
        {
            provide: HTTP_INTERCEPTORS,
            useClass: AuthInterceptorService,
            multi: true,
        }
    ],
    bootstrap: [AppComponent]
})
export class AppModule {
}
