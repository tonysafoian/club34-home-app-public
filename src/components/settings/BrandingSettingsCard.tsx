import { useState, useRef, ChangeEvent } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Palette, Upload, RotateCcw, Check, Sparkles, Building2, Image as ImageIcon } from 'lucide-react';
import { useBranding, THEME_COLOR_PRESETS, ThemeColorPreset } from '@/hooks/useBranding';
import { JanusLogo } from '@/components/brand/JanusLogo';
import { useToast } from '@/hooks/use-toast';

export default function BrandingSettingsCard() {
  const {
    estateName,
    setEstateName,
    customLogo,
    setCustomLogo,
    colorPreset,
    setColorPreset,
    resetBranding,
  } = useBranding();

  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [nameInput, setNameInput] = useState(estateName);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlField, setShowUrlField] = useState(false);

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    setEstateName(nameInput);
    toast({
      title: 'Estate Name Updated',
      description: `Renamed to "${nameInput.trim() || 'Janus'}"`,
    });
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Invalid File',
        description: 'Please upload an image file (PNG, JPG, SVG, or WebP).',
        variant: 'destructive',
      });
      return;
    }

    // Limit to 2MB for localStorage data URL
    if (file.size > 2 * 1024 * 1024) {
      toast({
        title: 'File Too Large',
        description: 'Please select an image smaller than 2MB.',
        variant: 'destructive',
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setCustomLogo(result);
      toast({
        title: 'Logo Updated',
        description: 'Your custom estate emblem has been applied.',
      });
    };
    reader.readAsDataURL(file);
  };

  const handleApplyLogoUrl = () => {
    if (!urlInput.trim()) return;
    setCustomLogo(urlInput.trim());
    setUrlInput('');
    setShowUrlField(false);
    toast({
      title: 'Logo URL Applied',
      description: 'Custom logo URL saved.',
    });
  };

  const handleResetLogo = () => {
    setCustomLogo(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    toast({
      title: 'Logo Reset',
      description: 'Restored default Janus emblem.',
    });
  };

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <Palette className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">Estate Branding & Appearance</CardTitle>
              <CardDescription>
                Customize your estate name, upload your family crest or logo, and select a theme color palette.
              </CardDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={resetBranding}
            className="text-xs text-muted-foreground hover:text-foreground gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Defaults
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Live Preview Card */}
        <div className="p-4 rounded-xl border border-border/50 bg-secondary/30 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <JanusLogo size="lg" variant="icon" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Live Emblem Preview</p>
              <h3 className="text-lg font-bold font-display tracking-tight text-foreground">{estateName}</h3>
              <p className="text-xs text-muted-foreground">Theme: {THEME_COLOR_PRESETS[colorPreset].name}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" className="janus-gradient text-primary-foreground font-medium shadow-sm">
              <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Primary Button
            </Button>
          </div>
        </div>

        {/* Section 1: Estate Name */}
        <form onSubmit={handleSaveName} className="space-y-2">
          <Label htmlFor="estateName" className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5 text-primary" /> Estate or Property Name
          </Label>
          <div className="flex gap-2">
            <Input
              id="estateName"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="e.g. Villa Paradiso, Oak Hill Estate, Janus"
              className="max-w-md bg-background"
            />
            <Button type="submit" variant="secondary" size="sm">
              Save Name
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            This name appears across the dashboard header, page titles, and morning briefings.
          </p>
        </form>

        {/* Section 2: Logo / Emblem Upload */}
        <div className="space-y-3 pt-2 border-t border-border/40">
          <Label className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <ImageIcon className="h-3.5 w-3.5 text-primary" /> Custom Estate Logo / Emblem
          </Label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              onChange={handleFileUpload}
              className="hidden"
              id="logo-upload"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="gap-2"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload Logo File (PNG, SVG, JPG)
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowUrlField(!showUrlField)}
              className="text-xs"
            >
              {showUrlField ? 'Cancel URL' : 'Use Image URL'}
            </Button>

            {customLogo && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleResetLogo}
                className="text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restore Default Emblem
              </Button>
            )}
          </div>

          {showUrlField && (
            <div className="flex gap-2 max-w-md pt-1">
              <Input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/estate-logo.png"
                className="bg-background text-xs"
              />
              <Button size="sm" variant="secondary" onClick={handleApplyLogoUrl}>
                Apply
              </Button>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Recommended: Square SVG or high-resolution PNG with transparent background.
          </p>
        </div>

        {/* Section 3: Luxury Color Themes */}
        <div className="space-y-3 pt-2 border-t border-border/40">
          <Label className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Palette className="h-3.5 w-3.5 text-primary" /> Accent Color Palette
          </Label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {(Object.keys(THEME_COLOR_PRESETS) as ThemeColorPreset[]).map((presetKey) => {
              const preset = THEME_COLOR_PRESETS[presetKey];
              const isSelected = colorPreset === presetKey;

              return (
                <button
                  key={presetKey}
                  type="button"
                  onClick={() => setColorPreset(presetKey)}
                  className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                    isSelected
                      ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary'
                      : 'border-border/60 hover:border-border hover:bg-secondary/40'
                  }`}
                >
                  <span
                    className="w-5 h-5 rounded-full shrink-0 shadow-sm flex items-center justify-center border border-white/20"
                    style={{ backgroundColor: preset.previewColor }}
                  >
                    {isSelected && <Check className="w-3 h-3 text-white stroke-[3]" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">{preset.name}</p>
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Changes are applied in real time across buttons, dials, badges, graphs, and lighting glows.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
