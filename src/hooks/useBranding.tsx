import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type ThemeColorPreset = 'amber' | 'emerald' | 'sapphire' | 'violet' | 'rose' | 'slate';

export interface ThemePresetDetails {
  id: ThemeColorPreset;
  name: string;
  previewColor: string;
  primary: string;
  ring: string;
  amber: string;
  copper: string;
}

export const THEME_COLOR_PRESETS: Record<ThemeColorPreset, ThemePresetDetails> = {
  amber: {
    id: 'amber',
    name: 'Classic Amber & Bronze',
    previewColor: '#f59e0b',
    primary: '35 85% 55%',
    ring: '35 85% 55%',
    amber: '35 85% 55%',
    copper: '25 75% 50%',
  },
  emerald: {
    id: 'emerald',
    name: 'Emerald Sanctuary',
    previewColor: '#10b981',
    primary: '152 65% 45%',
    ring: '152 65% 45%',
    amber: '152 65% 45%',
    copper: '160 70% 35%',
  },
  sapphire: {
    id: 'sapphire',
    name: 'Pacific Azure',
    previewColor: '#3b82f6',
    primary: '215 85% 55%',
    ring: '215 85% 55%',
    amber: '215 85% 55%',
    copper: '195 75% 45%',
  },
  violet: {
    id: 'violet',
    name: 'Obsidian Violet',
    previewColor: '#8b5cf6',
    primary: '270 75% 60%',
    ring: '270 75% 60%',
    amber: '270 75% 60%',
    copper: '290 70% 45%',
  },
  rose: {
    id: 'rose',
    name: 'Royal Bordeaux',
    previewColor: '#f43f5e',
    primary: '348 78% 55%',
    ring: '348 78% 55%',
    amber: '348 78% 55%',
    copper: '15 80% 50%',
  },
  slate: {
    id: 'slate',
    name: 'Nordic Slate',
    previewColor: '#94a3b8',
    primary: '215 20% 60%',
    ring: '215 20% 60%',
    amber: '215 20% 60%',
    copper: '220 15% 45%',
  },
};

const DEFAULT_ESTATE_NAME = 'Household OS';

interface BrandingContextType {
  estateName: string;
  setEstateName: (name: string) => void;
  customLogo: string | null;
  setCustomLogo: (logo: string | null) => void;
  colorPreset: ThemeColorPreset;
  setColorPreset: (preset: ThemeColorPreset) => void;
  resetBranding: () => void;
}

const BrandingContext = createContext<BrandingContextType | undefined>(undefined);

const STORAGE_KEYS = {
  ESTATE_NAME: 'household_os_estate_name',
  CUSTOM_LOGO: 'household_os_custom_logo',
  COLOR_PRESET: 'household_os_color_preset',
};

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [estateName, setEstateNameState] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(STORAGE_KEYS.ESTATE_NAME) || DEFAULT_ESTATE_NAME;
    }
    return DEFAULT_ESTATE_NAME;
  });

  const [customLogo, setCustomLogoState] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(STORAGE_KEYS.CUSTOM_LOGO) || null;
    }
    return null;
  });

  const [colorPreset, setColorPresetState] = useState<ThemeColorPreset>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEYS.COLOR_PRESET) as ThemeColorPreset;
      if (saved && THEME_COLOR_PRESETS[saved]) return saved;
    }
    return 'amber';
  });

  // Apply theme preset variables to document.documentElement
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const preset = THEME_COLOR_PRESETS[colorPreset] || THEME_COLOR_PRESETS.amber;

    root.style.setProperty('--primary', preset.primary);
    root.style.setProperty('--ring', preset.ring);
    root.style.setProperty('--sidebar-primary', preset.primary);
    root.style.setProperty('--club34-amber', preset.amber);
    root.style.setProperty('--club34-copper', preset.copper);

    localStorage.setItem(STORAGE_KEYS.COLOR_PRESET, colorPreset);
  }, [colorPreset]);

  // Sync document title to estate name
  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.title = estateName || DEFAULT_ESTATE_NAME;
    localStorage.setItem(STORAGE_KEYS.ESTATE_NAME, estateName);
  }, [estateName]);

  const setEstateName = (name: string) => {
    const val = name.trim() ? name : DEFAULT_ESTATE_NAME;
    setEstateNameState(val);
  };

  const setCustomLogo = (logo: string | null) => {
    setCustomLogoState(logo);
    if (logo) {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_LOGO, logo);
    } else {
      localStorage.removeItem(STORAGE_KEYS.CUSTOM_LOGO);
    }
  };

  const setColorPreset = (preset: ThemeColorPreset) => {
    setColorPresetState(preset);
  };

  const resetBranding = () => {
    setEstateNameState(DEFAULT_ESTATE_NAME);
    setCustomLogoState(null);
    setColorPresetState('amber');
    localStorage.removeItem(STORAGE_KEYS.ESTATE_NAME);
    localStorage.removeItem(STORAGE_KEYS.CUSTOM_LOGO);
    localStorage.removeItem(STORAGE_KEYS.COLOR_PRESET);
  };

  return (
    <BrandingContext.Provider
      value={{
        estateName,
        setEstateName,
        customLogo,
        setCustomLogo,
        colorPreset,
        setColorPreset,
        resetBranding,
      }}
    >
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  const context = useContext(BrandingContext);
  if (!context) {
    // Graceful fallback if called outside provider
    return {
      estateName: DEFAULT_ESTATE_NAME,
      setEstateName: () => {},
      customLogo: null,
      setCustomLogo: () => {},
      colorPreset: 'amber' as ThemeColorPreset,
      setColorPreset: () => {},
      resetBranding: () => {},
    };
  }
  return context;
}
