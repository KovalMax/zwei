import {getDeviceID} from '../login/login';
import {Token} from '../auth/token';

export interface RegistrationForm {
    email: string;
    password: string;
    confirmPassword: string;
    firstName: string;
    lastName: string;
    nickName: string;
}

export interface Registration {
    email: string;
    password: string;
    display_name: string;
    device_id: string;
    device_name?: string;
}

export type RegistrationResponse = Token;

export class RegistrationModel implements Registration {
    constructor(
        public email: string,
        public password: string,
        public display_name: string,
        public device_id: string,
    ) {
    }

    static createFrom(values: RegistrationForm): Registration {
        if (!('email' in values)) {
            throw new Error('email key not found');
        }
        if (!('firstName' in values)) {
            throw new Error('firstName key not found');
        }
        if (!('lastName' in values)) {
            throw new Error('lastName key not found');
        }
        if (!('nickName' in values)) {
            throw new Error('nickName key not found');
        }
        if (!('password' in values)) {
            throw new Error('password key not found');
        }

        return new RegistrationModel(
            values.email,
            values.password,
            values.nickName,
            getDeviceID(),
        );
    }
}
