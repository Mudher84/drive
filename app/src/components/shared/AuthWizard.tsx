import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Key, Lock, ArrowRight, ShieldCheck, Sun, Moon, QrCode, Languages } from "lucide-react";
import { useTheme } from '../../context/ThemeContext';
import { useSettings } from '../../context/SettingsContext';
import { open } from '@tauri-apps/plugin-shell';
import { QRCodeSVG } from 'qrcode.react';

import { useTranslation } from "react-i18next";

// Yam Drive ships with its own embedded Telegram API ID/Hash (see
// `telegram_credentials.rs` on the Rust side) — there's no more per-user
// "API ID / API Hash" setup step. Sign-in is just: identifier/phone number
// -> code (sent via a Telegram message) -> optional 2FA password. QR is an
// alternate method to the identifier+code flow, not a separate setup step.
type Step = "login" | "password";

function AuthThemeToggle() {
    const { theme, toggleTheme } = useTheme();
    return (
        <button
            onClick={toggleTheme}
            className="quiet-control absolute end-4 top-[calc(1rem+env(safe-area-inset-top,24px))] z-10 flex h-9 w-9 items-center justify-center border border-app-border bg-app-surface-raised text-app-text-secondary shadow-[var(--shadow-raised)] hover:text-app-text"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
            {theme === 'dark' ? (
                <Sun className="h-4 w-4" />
            ) : (
                <Moon className="h-4 w-4" />
            )}
        </button>
    );
}

/** One-tap toggle between Arabic and English on the login screen — the two
 *  languages this fork actively maintains (see the Arabic translation work
 *  and the `LANGUAGES` list). Drives the same `settings.language` value the
 *  rest of the app reads, so App.tsx's language/RTL effect picks it up. */
function AuthLanguageToggle() {
    const { settings, updateSetting } = useSettings();
    const isArabic = settings.language === 'ar';
    return (
        <button
            onClick={() => updateSetting('language', isArabic ? 'en' : 'ar')}
            className="quiet-control absolute end-16 top-[calc(1rem+env(safe-area-inset-top,24px))] z-10 flex h-9 items-center gap-1.5 border border-app-border bg-app-surface-raised px-2.5 text-app-text-secondary shadow-[var(--shadow-raised)] hover:text-app-text"
            title={isArabic ? 'Switch to English' : 'التبديل إلى العربية'}
            aria-label={isArabic ? 'Switch to English' : 'التبديل إلى العربية'}
        >
            <Languages className="h-4 w-4" />
            <span className="text-badge font-semibold">{isArabic ? 'EN' : 'AR'}</span>
        </button>
    );
}
export function AuthWizard({ onLogin }: { onLogin: () => void }) {
    const { t } = useTranslation();
    const isBrowser = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

    if (isBrowser) {
        return (
            <div className="auth-gradient flex h-full items-center justify-center p-6 text-center text-app-text">
              <div className="quiet-raised max-w-md p-6">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-container bg-app-danger/10">
                    <ShieldCheck className="h-6 w-6 text-app-danger" />
                </div>
                <h1 className="text-app-title font-semibold text-app-text">{t('auth.desktop_required')}</h1>
                <p className="mx-auto mt-2 max-w-sm text-ui leading-relaxed text-app-text-secondary">
                    {t('auth.desktop_required_desc')}
                </p>
                <div className="mt-5 rounded-control border border-app-border bg-app-surface-sunken/40 p-3 text-metadata text-app-text-secondary">
                    {t('auth.open_window_prompt')}
                </div>
              </div>
            </div>
        )
    }

    const [step, setStep] = useState<Step>("login");
    const [loading, setLoading] = useState(false);

    const [phone, setPhone] = useState("");
    const [codeRequested, setCodeRequested] = useState(false);
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [floodWait, setFloodWait] = useState<number | null>(null);
    const [loginMethod, setLoginMethod] = useState<'identifier' | 'qr'>('identifier');
    const isMobile = typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent.toLowerCase());

    useEffect(() => {
        if (isMobile && loginMethod !== 'identifier') {
            setLoginMethod('identifier');
        }
    }, [isMobile, loginMethod]);
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [qrPolling, setQrPolling] = useState(false);
    const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);


    useEffect(() => {
        if (!floodWait) return;
        const interval = setInterval(() => {
            setFloodWait(prev => {
                if (prev === null || prev <= 1) return null;
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [floodWait]);

    const handleQrLogin = async () => {
        setError(null);
        setLoading(true);
        try {
            const url = await invoke<string>("cmd_auth_qr_login");

            if (url === "__authorized__") {
                onLogin();
                return;
            }

            setQrUrl(url);
            setQrPolling(true);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    // QR polling effect
    useEffect(() => {
        if (!qrPolling) {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
            return;
        }

        qrPollRef.current = setInterval(async () => {
            try {
                const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_qr_poll");
                if (res.success) {
                    setQrPolling(false);
                    if (res.next_step === "password") {
                        setStep("password");
                    } else {
                        onLogin();
                    }
                }
                // If next_step === "waiting", keep polling
            } catch {
                // Polling error — keep trying silently
            }
        }, 3000);

        return () => {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
        };
    }, [qrPolling]);

    // Step 1 of the identifier flow — request a login code, sent to you via
    // a Telegram message (or SMS as a fallback), same as scanning starts a
    // QR flow. Doesn't submit/sign in by itself — just unlocks the code field.
    const handleRequestCode = async () => {
        if (!phone) return;
        setLoading(true);
        setError(null);
        try {
            await invoke("cmd_auth_request_code", { phone });
            setCodeRequested(true);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : JSON.stringify(err);
            if (msg.includes("FLOOD_WAIT_")) {
                const parts = msg.split("FLOOD_WAIT_");
                if (parts[1]) {
                    const seconds = parseInt(parts[1]);
                    if (!isNaN(seconds)) {
                        setFloodWait(seconds);
                        return;
                    }
                }
            }
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    // Step 2 — the code you received is submitted from the same screen
    // (in the field that used to be "API Hash"), and completes sign-in.
    const handleLoginSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!codeRequested || !code) return;
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_sign_in", { code });
            if (res.success) {
                onLogin();
            } else if (res.next_step === "password") {
                setStep("password");
            } else {
                setError("Unknown error");
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_check_password", { password });
            if (res.success) {
                onLogin();
            } else {
                setError("Password verification failed.");
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative flex h-full w-full overflow-hidden text-app-text">
            <AuthThemeToggle />
            <AuthLanguageToggle />

            {/* Brand panel — solid accent-colored block with the logo, matching a
                split-screen login layout (form on one side, brand block on the
                other). Hidden on narrow/mobile widths where there isn't room
                for two panels. */}
            <div className="relative hidden shrink-0 flex-col items-center justify-center overflow-hidden bg-app-accent p-10 text-center md:flex md:w-[42%] lg:w-[38%]">
                <div
                    className="pointer-events-none absolute inset-0 opacity-[0.08]"
                    style={{
                        backgroundImage: 'radial-gradient(circle at 20% 20%, #fff 0, transparent 45%), radial-gradient(circle at 80% 70%, #fff 0, transparent 40%)',
                    }}
                />
                <div className="relative flex h-28 w-28 items-center justify-center">
                    <img src="/logo.svg" alt="Logo" className="h-full w-full drop-shadow-[0_4px_16px_rgba(0,0,0,0.25)]" />
                </div>
                <h1 className="relative mt-5 text-2xl font-semibold tracking-[-0.01em] text-white">Yam Drive</h1>
                <p className="relative mt-2 max-w-[20rem] text-ui leading-relaxed text-white/75">
                    {t('auth.brand_tagline')}
                </p>
                <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); open('https://www.wana84.com'); }}
                    className="quiet-control relative mt-6 cursor-pointer text-metadata text-white/60 hover:text-white/90"
                >
                    © {new Date().getFullYear()} Mudher Al.Bayai
                </button>
            </div>

            {/* Form panel */}
            <div className="auth-gradient flex h-full w-full flex-1 items-center justify-center overflow-y-auto p-4 pt-[calc(1rem+env(safe-area-inset-top,24px))] sm:p-6">
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="auth-glass my-auto w-full max-w-[26rem] rounded-overlay p-5 sm:p-6"
            >
                <div className="mb-6 text-center md:hidden">
                    <div className="mx-auto mb-3 flex h-20 w-20 items-center justify-center">
                        <img src="/logo.svg" alt="Logo" className="w-full h-full" />
                    </div>
                    <h1 className="text-app-title font-semibold tracking-[-0.01em] text-app-text">Yam Drive</h1>
                    <p className="mt-1 text-metadata text-app-text-secondary">{t('auth.tagline')}</p>
                    <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); open('https://www.wana84.com'); }}
                        className="quiet-control mt-2 cursor-pointer text-metadata text-app-text-tertiary hover:text-app-text-secondary"
                    >
                        © {new Date().getFullYear()} Mudher Al.Bayai
                    </button>
                </div>
                <div className="mb-6 hidden text-center md:block">
                    <h2 className="text-app-title font-semibold tracking-[-0.01em] text-app-text">{t('auth.sign_in_title')}</h2>
                    <p className="mt-1 text-metadata text-app-text-secondary">{t('auth.sign_in_subtitle')}</p>
                </div>

                <AnimatePresence mode="wait">
                    {floodWait ? (
                        <motion.div
                            key="flood"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="space-y-5 text-center"
                        >
                            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-container bg-app-danger/10">
                                <span className="text-xl">⏳</span>
                            </div>
                            <div>
                                <h2 className="text-app-title font-semibold text-app-text">{t('auth.too_many_requests')}</h2>
                                <p className="mt-2 text-ui text-app-text-secondary">{t('auth.flood_wait_msg')}</p>
                                <p className="text-ui text-app-text-secondary">{t('auth.please_wait')}</p>
                            </div>

                            <div className="flex items-center justify-center font-mono text-3xl font-semibold tabular-nums text-app-accent">
                                {Math.floor(floodWait / 60)}:{(floodWait % 60).toString().padStart(2, '0')}
                            </div>

                            <p className="mt-4 text-metadata text-app-danger">
                                {t('auth.timer_reset_warning')}
                            </p>
                        </motion.div>
                    ) : (
                        <>

                            {step === "login" && (
                                <motion.div
                                    key="login"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    className="space-y-5"
                                >
                                    {/* Identifier / QR toggle */}
                                    {!isMobile && (
                                        <div className="quiet-control flex overflow-hidden border border-app-border bg-app-surface-sunken/40 p-0.5">
                                            <button
                                                type="button"
                                                onClick={() => { setLoginMethod('identifier'); setQrUrl(null); setQrPolling(false); setError(null); }}
                                                className={`quiet-control flex h-8 flex-1 items-center justify-center gap-2 text-metadata font-medium ${
                                                    loginMethod === 'identifier'
                                                        ? 'bg-app-surface-raised text-app-text shadow-sm'
                                                        : 'text-app-text-secondary hover:text-app-text'
                                                }`}
                                            >
                                                <Phone className="w-4 h-4" /> {t('auth.toggle_id_phone')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => { setLoginMethod('qr'); setError(null); handleQrLogin(); }}
                                                className={`quiet-control flex h-8 flex-1 items-center justify-center gap-2 text-metadata font-medium ${
                                                    loginMethod === 'qr'
                                                        ? 'bg-app-surface-raised text-app-text shadow-sm'
                                                        : 'text-app-text-secondary hover:text-app-text'
                                                }`}
                                            >
                                                <QrCode className="w-4 h-4" /> {t('auth.qr_code')}
                                            </button>
                                        </div>
                                    )}

                                    {loginMethod === 'identifier' ? (
                                        <form onSubmit={handleLoginSubmit} className="space-y-4">
                                            <div className="space-y-3">
                                                <div>
                                                    <label className="auth-label">{t('auth.select_country', 'اختر الدولة (Country)')}</label>
                                                    <div className="relative">
                                                        <select 
                                                            className="auth-input appearance-none bg-app-surface-sunken/40 cursor-pointer"
                                                            onChange={(e) => { 
                                                                const val = e.target.value;
                                                                if (val) {
                                                                    setPhone(val + " ");
                                                                    setCodeRequested(false);
                                                                    setCode("");
                                                                }
                                                            }}
                                                        >
                                                            <option value="" disabled selected>اختر الدولة...</option>
                                                            <option value="+964">🇮🇶 العراق (+964)</option>
                                                            <option value="+966">🇸🇦 السعودية (+966)</option>
                                                            <option value="+20">🇪🇬 مصر (+20)</option>
                                                            <option value="+971">🇦🇪 الإمارات (+971)</option>
                                                            <option value="+965">🇰🇼 الكويت (+965)</option>
                                                            <option value="+962">🇯🇴 الأردن (+962)</option>
                                                            <option value="+974">🇶🇦 قطر (+974)</option>
                                                            <option value="+968">🇴🇲 عمان (+968)</option>
                                                            <option value="+973">🇧🇭 البحرين (+973)</option>
                                                            <option value="+213">🇩🇿 الجزائر (+213)</option>
                                                            <option value="+212">🇲🇦 المغرب (+212)</option>
                                                            <option value="+218">🇱🇾 ليبيا (+218)</option>
                                                            <option value="+249">🇸🇩 السودان (+249)</option>
                                                            <option value="+1">🇺🇸 أمريكا (+1)</option>
                                                            <option value="+44">🇬🇧 بريطانيا (+44)</option>
                                                            <option value="">🌍 أخرى (اكتب يدوياً)</option>
                                                        </select>
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="auth-label">{t('auth.identifier_label')}</label>
                                                    <div className="flex items-stretch gap-2">
                                                        <div className="relative flex-1">
                                                            <Phone className="auth-input-icon" />
                                                            <input
                                                                type="tel"
                                                                value={phone}
                                                                onChange={(e) => { setPhone(e.target.value); setCodeRequested(false); setCode(""); }}
                                                                placeholder="+1 234 567 8900"
                                                                className="auth-input tracking-wide"
                                                                dir="ltr"
                                                            />
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={handleRequestCode}
                                                            disabled={loading || !phone}
                                                            className="quiet-control shrink-0 border border-app-border bg-app-surface-raised px-3 text-metadata font-medium text-app-text-secondary hover:text-app-text disabled:opacity-45"
                                                        >
                                                            {loading && !codeRequested ? "..." : (codeRequested ? t('auth.resend_code') : t('auth.get_code'))}
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            <div>
                                                <label className="auth-label">{t('auth.code_label')}</label>
                                                <div className="relative">
                                                    <Key className="auth-input-icon" />
                                                    <input
                                                        type="text"
                                                        value={code}
                                                        onChange={(e) => setCode(e.target.value)}
                                                        placeholder={codeRequested ? "1 2 3 4 5" : t('auth.request_code_first')}
                                                        disabled={!codeRequested}
                                                        className="auth-input pe-3 ps-10 text-center font-mono text-base tracking-[0.4em] disabled:opacity-45"
                                                    />
                                                </div>
                                                <p className="mt-1.5 text-metadata text-app-text-tertiary">
                                                    {t('auth.code_arrival_note')}
                                                </p>
                                            </div>

                                            <button
                                                type="submit"
                                                disabled={loading || !codeRequested || !code}
                                                className="quiet-control auth-primary-action disabled:opacity-45"
                                            >
                                                {loading && codeRequested ? t('auth.signing_in') : <>{t('auth.sign_in_button')} <ArrowRight className="h-4 w-4 rtl:rotate-180" /></>}
                                            </button>
                                        </form>
                                    ) : (
                                        <div className="flex flex-col items-center gap-5">
                                            {loading && !qrUrl && (
                                                <div className="flex h-52 w-52 items-center justify-center rounded-container bg-app-surface-sunken/45">
                                                    <div className="h-7 w-7 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
                                                </div>
                                            )}
                                            {qrUrl && (
                                                <>
                                                    <div className="rounded-container bg-white p-3 shadow-[var(--shadow-raised)]">
                                                        <QRCodeSVG
                                                            value={qrUrl}
                                                            size={200}
                                                            level="M"
                                                            bgColor="#ffffff"
                                                            fgColor="#000000"
                                                        />
                                                    </div>
                                                    <div className="text-center space-y-1">
                                                        <p className="text-ui text-app-text">{t('auth.scan_qr')}</p>
                                                        <p className="text-metadata text-app-text-tertiary">{t('auth.qr_instructions')}</p>
                                                    </div>
                                                    {qrPolling && (
                                                        <div className="flex items-center gap-2 text-metadata text-app-accent">
                                                            <div className="h-3 w-3 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
                                                            {t('auth.waiting_for_scan')}
                                                        </div>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={handleQrLogin}
                                                        className="quiet-control auth-secondary-action px-2"
                                                    >
                                                        {t('auth.refresh_qr')}
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    )}

                                    {import.meta.env.DEV && (
                                        <button
                                            type="button"
                                            onClick={() => onLogin()}
                                            className="quiet-control auth-secondary-action w-full text-app-danger"
                                        >
                                            {t('auth.dev_mode')}
                                        </button>
                                    )}
                                </motion.div>
                            )}


                            {step === "password" && (
                                <motion.form
                                    key="password"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handlePasswordSubmit}
                                    className="space-y-5"
                                >
                                    <div className="space-y-2">
                                        <div className="mb-4 rounded-control border border-app-accent/20 bg-app-selected p-3">
                                            <p className="text-center text-metadata text-app-accent">
                                                {t('auth.two_factor_enabled')}
                                            </p>
                                        </div>
                                        <label className="auth-label">{t('auth.cloud_password')}</label>
                                        <div className="relative">
                                            <Lock className="auth-input-icon" />
                                            <input
                                                type="password"
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                placeholder={t('auth.password_placeholder')}
                                                className="auth-input"
                                                autoFocus
                                            />
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3">
                                        <button
                                            type="submit"
                                            disabled={loading || !password}
                                            className="quiet-control auth-primary-action disabled:opacity-45"
                                        >
                                            {loading ? t('auth.verifying') : t('auth.unlock')}
                                        </button>
                                        <button type="button" onClick={() => { setStep("login"); setPassword(""); setError(null); }} className="quiet-control auth-secondary-action w-full">
                                            {t('auth.back_to_sign_in')}
                                        </button>
                                    </div>
                                </motion.form>
                            )}
                        </>
                    )}
                </AnimatePresence>

                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-5 flex items-start gap-2 rounded-control border border-app-danger/20 bg-app-danger/10 p-3"
                    >
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 shrink-0" />
                        <p className="text-ui leading-snug text-app-danger">{error}</p>
                    </motion.div>
                )}

            </motion.div>
            </div>

        </div>
    );
}
