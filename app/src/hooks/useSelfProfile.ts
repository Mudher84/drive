import { useEffect, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';

export interface SelfProfile {
    id: number;
    name: string;
    username: string | null;
    photo_path: string | null;
}

/**
 * Fetches the signed-in Telegram account's name + avatar (via the
 * `cmd_get_self_profile` Tauri command) once the app is connected, so the
 * sidebar can show a real profile picture instead of a generic icon.
 */
export function useSelfProfile(isConnected: boolean) {
    const [profile, setProfile] = useState<SelfProfile | null>(null);

    useEffect(() => {
        if (!isConnected) return;
        let cancelled = false;

        invoke<SelfProfile>('cmd_get_self_profile')
            .then(result => {
                if (!cancelled) setProfile(result);
            })
            .catch(error => {
                console.warn('Failed to load self profile:', error);
            });

        return () => {
            cancelled = true;
        };
    }, [isConnected]);

    const avatarSrc = profile?.photo_path ? convertFileSrc(profile.photo_path) : null;

    return { profile, avatarSrc };
}
