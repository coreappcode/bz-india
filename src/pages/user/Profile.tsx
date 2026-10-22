import React, { useState, useEffect, useRef } from 'react';
import logger from '../../utils/logger';
import { useNavigate } from 'react-router-dom';
import { LogOut, CheckCircle, X, Trash2, Home, Briefcase, MapPin, Plus, Shield, User, Mail, Phone, Globe, Lock, Key, Download, Edit2, SlidersHorizontal, ChevronRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { getUserAddresses } from '../../lib/adminService';
import { Header } from '../../components/layout/Header';
import { Footer } from '../../components/layout/Footer';
import { MobileNav } from '../../components/layout/MobileNav';
import { Skeleton, FormSkeleton, ListSkeleton } from '../../components/common/Skeleton';

interface CountryOption {
  id: string;
  country_name: string;
  country_code?: string | null;
  short_code?: string | null;
  iso2?: string | null;
}

type EditingField = 'name' | 'phone' | 'country' | null;

interface ProfileAddress {
  id: string;
  full_name: string;
  phone_number?: string | null;
  street_address_1: string;
  street_address_2?: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  address_type: string;
  is_default: boolean;
}

export const Profile: React.FC = () => {
  const navigate = useNavigate();
  const { user, currentAuthUser, loading: authLoading, signOut } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [locationLockedCountryId, setLocationLockedCountryId] = useState('');
  const [locationLockedCountryName, setLocationLockedCountryName] = useState('');
  const [locationRefreshTick, setLocationRefreshTick] = useState(0);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [addresses, setAddresses] = useState<ProfileAddress[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(true);
  // Ref guards — prevent duplicate DB writes and avoid re-triggering fetch on location state
  const locationLockedCountryIdRef = useRef('');
  const locationLockedCountryNameRef = useRef('');
  const countryLockAppliedRef = useRef('');

  const [profileData, setProfileData] = useState({
    name: '',
    email: '',
    phone: '',
    country: '',
    countryId: '',
  });

  // Temp edit values for inline editing
  const [editValue, setEditValue] = useState('');

  const normalizeCountryToken = (value: string) =>
    String(value || '').trim().toUpperCase().replace(/\s+/g, '');

  const resolveDetectedCountry = (countryRows: CountryOption[]) => {
    try {
      const raw = localStorage.getItem('beauzead_detected_location');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { country?: string; countryCode?: string };
      const tokens = new Set([
        normalizeCountryToken(String(parsed.country || '')),
        normalizeCountryToken(String(parsed.countryCode || '')),
      ]);

      for (const row of countryRows) {
        const rowTokens = [
          normalizeCountryToken(row.country_name),
          normalizeCountryToken(String(row.country_code || '')),
          normalizeCountryToken(String(row.short_code || '')),
          normalizeCountryToken(String(row.iso2 || '')),
        ];
        if (rowTokens.some((token) => token && tokens.has(token))) {
          return row;
        }
      }
    } catch {
      // Ignore malformed cached location
    }
    return null;
  };

  useEffect(() => {
    // Only re-detect on an explicit location update event — NOT on every window focus.
    // Window focus was causing the profile to blink on every tab switch / click.
    const onLocationUpdated = () => setLocationRefreshTick((prev) => prev + 1);
    window.addEventListener('beauzead:location-updated', onLocationUpdated);
    return () => {
      window.removeEventListener('beauzead:location-updated', onLocationUpdated);
    };
  }, []);

  // Fetch countries list
  useEffect(() => {
    const loadCountries = async () => {
      try {
        const { data } = await supabase
          .from('countries')
          .select('id, country_name, country_code, short_code, iso2')
          .eq('is_active', true)
          .order('country_name');
        if (data) setCountries(data);
      } catch (err) {
        logger.error(err as Error, { context: 'Failed to load countries' });
      }
    };
    loadCountries();
  }, []);

  // Keep country locked to detected location when available
  useEffect(() => {
    if (countries.length === 0) return;

    const detected = resolveDetectedCountry(countries);
    if (!detected) {
      setLocationLockedCountryId('');
      setLocationLockedCountryName('');
      return;
    }

    setLocationLockedCountryId(detected.id);
    setLocationLockedCountryName(detected.country_name);
    // Keep refs in sync so fetchUserProfile can read current values without being in its dep array
    locationLockedCountryIdRef.current = detected.id;
    locationLockedCountryNameRef.current = detected.country_name;
    setProfileData((prev) => ({
      ...prev,
      countryId: detected.id,
      country: detected.country_name,
    }));
  }, [countries, locationRefreshTick]);

  // Fetch user profile on mount
  useEffect(() => {
    const fetchUserProfile = async () => {
      try {
        setLoading(true);
        if (authLoading) {
          return;
        }

        const userId = user?.id || currentAuthUser?.userId;
        if (!userId) {
          navigate('/login');
          return;
        }

        const { data, error: fetchError } = await supabase
          .from('profiles')
          .select('full_name, email, phone, country_id')
          .eq('id', userId)
          .single();

        if (fetchError) {
          // Fallback to auth context data and self-heal missing profile rows.
          // Some legacy accounts exist in auth.users but have no profiles row.
          let resolvedCountry = '';
          let resolvedCountryId = '';

          try {
            const { data: authData } = await supabase.auth.getUser();
            const authUser = authData?.user;
            const metaCountryId = String(authUser?.user_metadata?.country_id || '').trim();
            const metaFullName = String(authUser?.user_metadata?.full_name || user?.full_name || '').trim();
            const metaPhone = String(authUser?.user_metadata?.phone || user?.phone || '').trim();
            const metaEmail = String(authUser?.email || user?.email || '').trim();

            if (metaCountryId) {
              resolvedCountryId = metaCountryId;
              const { data: countryRow } = await supabase
                .from('countries')
                .select('id, country_name')
                .eq('id', metaCountryId)
                .single();
              if (countryRow) {
                resolvedCountry = countryRow.country_name;
              }
            }

            // Best-effort backfill so future reads use profiles as source of truth.
            if (authUser?.id) {
              await supabase
                .from('profiles')
                .upsert(
                  {
                    id: authUser.id,
                    email: metaEmail,
                    full_name: metaFullName,
                    phone: metaPhone,
                    ...(resolvedCountryId ? { country_id: resolvedCountryId } : {}),
                  },
                  { onConflict: 'id' }
                );
            }
          } catch (_) {
            // Keep UI fallback resilient even if profile backfill fails.
          }

          setProfileData({
            name: user?.full_name || '',
            email: user?.email || '',
            phone: user?.phone || '',
            country: locationLockedCountryNameRef.current || resolvedCountry,
            countryId: locationLockedCountryIdRef.current || resolvedCountryId,
          });
        } else if (data) {
          let resolvedCountry = '';
          let resolvedCountryId = data.country_id || '';

          // Fallback: if profile has country_id but relation did not resolve, fetch country name directly
          if (resolvedCountryId && !resolvedCountry) {
            try {
              const { data: countryRow } = await supabase
                .from('countries')
                .select('id, country_name')
                .eq('id', resolvedCountryId)
                .single();

              if (countryRow) {
                resolvedCountry = countryRow.country_name;
              }
            } catch (_) { /* ignore fallback errors */ }
          }

          // Fallback: if profile has no country_id, check auth metadata and try to backfill
          if (!resolvedCountryId) {
            try {
              const { data: authData } = await supabase.auth.getUser();
              const metaCountryId = authData?.user?.user_metadata?.country_id;
              if (metaCountryId) {
                // Resolve country name from the ID
                const { data: countryRow } = await supabase
                  .from('countries')
                  .select('id, country_name')
                  .eq('id', metaCountryId)
                  .single();
                if (countryRow) {
                  resolvedCountry = countryRow.country_name;
                  resolvedCountryId = countryRow.id;
                  // Backfill the profile so it won't be missing next time — verify with .select()
                  await supabase
                    .from('profiles')
                    .update({ country_id: metaCountryId })
                    .eq('id', userId)
                    .select('country_id')
                    .single();
                }
              }
            } catch (_) { /* ignore fallback errors */ }
          }

          setProfileData({
            name: data.full_name || '',
            email: data.email || '',
            phone: data.phone || '',
            // Use refs so this effect is NOT re-triggered every time the location state updates
            country: locationLockedCountryNameRef.current || resolvedCountry,
            countryId: locationLockedCountryIdRef.current || resolvedCountryId,
          });
        }
      } catch (err) {
        logger.error(err as Error, { context: 'Failed to fetch user profile' });
        setError('Failed to load profile data');
      } finally {
        setLoading(false);
      }
    };

    fetchUserProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, currentAuthUser, authLoading, navigate]);
  // locationLockedCountryId / locationLockedCountryName intentionally omitted — read via refs
  // to prevent re-fetching (and re-blinking) every time location state changes.

  useEffect(() => {
    const loadAddresses = async () => {
      const userId = user?.id || currentAuthUser?.userId;
      if (!userId) {
        setAddresses([]);
        setAddressesLoading(false);
        return;
      }

      try {
        setAddressesLoading(true);
        const { data } = await getUserAddresses(userId);
        setAddresses((data || []) as ProfileAddress[]);
      } catch (err) {
        logger.error(err as Error, { context: 'Failed to load profile addresses' });
        setAddresses([]);
      } finally {
        setAddressesLoading(false);
      }
    };

    if (!authLoading) {
      void loadAddresses();
    }
  }, [user, currentAuthUser, authLoading]);

  // Persist locked detected country to profile + auth metadata once user is known.
  // countryLockAppliedRef ensures this only writes to DB once per detected country ID,
  // preventing an infinite loop caused by profileData.countryId being in the dep array.
  useEffect(() => {
    const applyDetectedCountryLock = async () => {
      const userId = user?.id || currentAuthUser?.userId;
      if (!userId || !locationLockedCountryId) return;

      // Guard: only apply once per lock ID to avoid infinite update loops
      if (countryLockAppliedRef.current === locationLockedCountryId) return;

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ country_id: locationLockedCountryId })
        .eq('id', userId);

      if (updateError) {
        logger.error(updateError as Error, { context: 'Failed to lock profile country to detected location' });
        return;
      }

      countryLockAppliedRef.current = locationLockedCountryId;
      await supabase.auth.updateUser({ data: { country_id: locationLockedCountryId } });
      setProfileData((prev) => ({
        ...prev,
        countryId: locationLockedCountryId,
        country: locationLockedCountryName || prev.country,
      }));
    };

    void applyDetectedCountryLock();
  }, [user, currentAuthUser, locationLockedCountryId, locationLockedCountryName]);

  const startEditing = (field: EditingField) => {
    if (field === 'country' && locationLockedCountryId) return;
    setEditingField(field);
    setError(null);
    setSuccessMessage(null);
    if (field === 'name') setEditValue(profileData.name);
    else if (field === 'phone') setEditValue(profileData.phone);
    else if (field === 'country') {
      const fallbackCountryId = countries.find((country) => country.country_name === profileData.country)?.id || '';
      setEditValue(profileData.countryId || fallbackCountryId);
    }
  };

  const cancelEditing = () => {
    setEditingField(null);
    setEditValue('');
    setError(null);
  };

  const handleSaveField = async (field: 'name' | 'phone' | 'country') => {
    try {
      setSaving(true);
      setError(null);

      const trimmed = editValue.trim();
      if (!trimmed) {
        setError('Please enter a value before saving.');
        setSaving(false);
        return;
      }

      const userId = user?.id || currentAuthUser?.userId;
      if (!userId) throw new Error('User not authenticated');

      if (field === 'country') {
        // Update country_id FK — use .select() to verify the row was actually updated
        const { data: updatedRow, error: updateError } = await supabase
          .from('profiles')
          .update({ country_id: trimmed })
          .eq('id', userId)
          .select('country_id')
          .single();
        if (updateError) throw updateError;
        if (!updatedRow) throw new Error('Profile update returned no data — row may not exist or RLS blocked the write.');

        // Also sync country_id into auth user_metadata so the fallback always works
        await supabase.auth.updateUser({ data: { country_id: trimmed } });

        const { data: selectedCountryRow, error: countryFetchError } = await supabase
          .from('countries')
          .select('id, country_name')
          .eq('id', trimmed)
          .maybeSingle();
        if (countryFetchError) throw countryFetchError;

        const selectedCountry = selectedCountryRow || countries.find(c => c.id === trimmed);
        setProfileData(prev => ({
          ...prev,
          country: selectedCountry?.country_name || prev.country,
          countryId: trimmed,
        }));
      } else {
        const updateMap: Record<string, string> = {
          name: 'full_name',
          phone: 'phone',
        };

        if (field === 'phone' && trimmed.replace(/\D/g, '').length < 6) {
          setError('Please enter a valid phone number.');
          setSaving(false);
          return;
        }

        const dbColumn = updateMap[field];
        const { data: updatedRow, error: updateError } = await supabase
          .from('profiles')
          .update({ [dbColumn]: trimmed })
          .eq('id', userId)
          .select(dbColumn)
          .single();
        if (updateError) throw updateError;
        if (!updatedRow) throw new Error('Profile update returned no data — please try again.');

        setProfileData(prev => ({ ...prev, [field]: trimmed }));
      }

      setSuccessMessage(`${field.charAt(0).toUpperCase() + field.slice(1)} updated successfully!`);
      setEditingField(null);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      logger.error(err as Error, { context: `Failed to update ${field}` });
      const message = err?.message || `Failed to update ${field}. Please try again.`;
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/');
  };

  const getAddressTypeIcon = (type: string) => {
    if (type === 'work') return <Briefcase className="w-4 h-4" />;
    if (type === 'home') return <Home className="w-4 h-4" />;
    return <MapPin className="w-4 h-4" />;
  };

  const formatAddressLine = (address: ProfileAddress) => {
    const line1 = [address.street_address_1, address.street_address_2].filter(Boolean).join(', ');
    const line2 = [address.city, address.state, address.postal_code].filter(Boolean).join(', ');
    return { line1, line2, country: address.country };
  };

  const renderFieldIcon = (icon: React.ReactNode) => (
    <div className="profile-field-icon" aria-hidden>{icon}</div>
  );

  // Show loading state
  if (loading) {
    return (
      <div className="profile-page-shell">
        <Header />
        <main className="profile-page-main">
          <div className="w-full max-w-2xl mx-auto px-4 py-6 space-y-6">
            <div className="flex items-center gap-4">
              <Skeleton rounded="full" className="h-16 w-16" />
              <div className="flex-1 space-y-2">
                <Skeleton rounded="sm" className="h-4 w-1/2" />
                <Skeleton rounded="sm" className="h-3 w-1/3" />
              </div>
            </div>
            <FormSkeleton fields={5} />
          </div>
        </main>
        <Footer />
        <MobileNav />
      </div>
    );
  }

  return (
    <div className="profile-page-shell">
      <Header />
      <main className="profile-page-main">
      <div className="profile-page-inner">
        <nav className="profile-breadcrumb" aria-label="Breadcrumb">
          <button type="button" onClick={() => navigate('/')} className="profile-breadcrumb-link">Home</button>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400" aria-hidden />
          <button type="button" onClick={() => navigate('/profile')} className="profile-breadcrumb-link">My Account</button>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400" aria-hidden />
          <span className="profile-breadcrumb-current">My Profile</span>
        </nav>
        <h1 className="profile-page-title">My Profile</h1>

        <div className="profile-layout">
          <div className="profile-layout-main">

        {successMessage && (
          <div className="auth-alert auth-alert--success mb-6">
            <CheckCircle className="h-5 w-5 shrink-0" />
            <span className="flex-1">{successMessage}</span>
            <button onClick={() => setSuccessMessage(null)} type="button" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {error && editingField === null && (
          <div className="auth-alert auth-alert--error mb-6">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} type="button" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="profile-card">
          <div className="profile-card-header">
            <Shield className="w-5 h-5 text-[#6D28D9]" />
            <h2 className="profile-card-title">Login and Security</h2>
          </div>

          {/* ── Name ── */}
          <div className="profile-row">
            {editingField === 'name' ? (
              <div className="space-y-3">
                <label className="profile-row-label">Name</label>
                <input
                  type="text"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  className="profile-field-input"
                  autoFocus
                />
                {error && editingField === 'name' && (
                  <p className="text-red-600 text-xs">{error}</p>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => handleSaveField('name')}
                    disabled={saving}
                    className="profile-save-btn"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={cancelEditing} type="button" className="profile-cancel-btn">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="profile-field-row">
                {renderFieldIcon(<User className="w-4 h-4" />)}
                <div className="profile-field-body min-w-0">
                  <p className="profile-row-label">Name</p>
                  <p className="profile-row-value">{profileData.name || '—'}</p>
                </div>
                <button
                  onClick={() => startEditing('name')}
                  type="button"
                  className="profile-pill-btn"
                >
                  Edit
                </button>
              </div>
            )}
          </div>

          {/* ── Email ── */}
          <div className="profile-row">
            <div className="profile-field-row">
              {renderFieldIcon(<Mail className="w-4 h-4" />)}
              <div className="profile-field-body min-w-0">
                <p className="profile-row-label">Email</p>
                <p className="profile-row-value">{profileData.email || '—'}</p>
                <p className="profile-row-hint">Email address cannot be changed</p>
              </div>
            </div>
          </div>

          {/* ── Primary Mobile Number ── */}
          <div className="profile-row">
            {editingField === 'phone' ? (
              <div className="space-y-3">
                <label className="profile-row-label">Primary mobile number</label>
                <input
                  type="tel"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  className="profile-field-input"
                  autoFocus
                />
                {error && editingField === 'phone' && (
                  <p className="text-red-600 text-xs">{error}</p>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => handleSaveField('phone')}
                    disabled={saving}
                    className="profile-save-btn"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={cancelEditing} type="button" className="profile-cancel-btn">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="profile-field-row">
                {renderFieldIcon(<Phone className="w-4 h-4" />)}
                <div className="profile-field-body min-w-0">
                  <p className="profile-row-label">Phone</p>
                  <p className="profile-row-value">{profileData.phone || '—'}</p>
                </div>
                <button
                  onClick={() => startEditing('phone')}
                  type="button"
                  className="profile-pill-btn"
                >
                  Edit
                </button>
              </div>
            )}
          </div>

          {/* ── Country ── */}
          <div className="profile-row">
            {editingField === 'country' ? (
              <div className="space-y-3">
                <label className="profile-row-label">Country</label>
                <select
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  className="profile-field-input bg-white"
                  autoFocus
                >
                  <option value="">Select a country</option>
                  {countries.map(c => (
                    <option key={c.id} value={c.id}>{c.country_name}</option>
                  ))}
                </select>
                {error && editingField === 'country' && (
                  <p className="text-red-600 text-xs">{error}</p>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => handleSaveField('country')}
                    disabled={saving}
                    className="profile-save-btn"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={cancelEditing} type="button" className="profile-cancel-btn">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="profile-field-row">
                  {renderFieldIcon(<Globe className="w-4 h-4" />)}
                  <div className="profile-field-body min-w-0">
                    <p className="profile-row-label">Country</p>
                    <p className="profile-row-value">{profileData.country || 'Not set'}</p>
                    {locationLockedCountryId && (
                      <p className="profile-row-hint">
                        Your account is registered in {profileData.country || 'your detected region'}.
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => startEditing('country')}
                    disabled={Boolean(locationLockedCountryId)}
                    type="button"
                    className="profile-pill-btn"
                  >
                    {locationLockedCountryId ? 'Locked' : 'Edit'}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ── Password ── */}
          <div className="profile-row">
            <div className="profile-field-row">
              {renderFieldIcon(<Lock className="w-4 h-4" />)}
              <div className="profile-field-body min-w-0">
                <p className="profile-row-label">Password</p>
                <p className="profile-row-value tracking-widest">••••••••••</p>
              </div>
              <button
                onClick={() => navigate('/user/settings')}
                type="button"
                className="profile-pill-btn"
              >
                Change
              </button>
            </div>
          </div>

          {/* ── Account actions ── */}
          <div className="profile-row profile-row--actions">
            <p className="profile-row-label">Account Actions</p>
            <p className="profile-row-hint mb-4">Manage your account settings and preferences.</p>
            <div className="profile-account-actions-grid">
              <button
                type="button"
                onClick={() => navigate('/contact', { state: { subject: 'Download My Data Request' } })}
                className="profile-account-action-card"
              >
                <Download className="w-4 h-4 text-[#6D28D9]" />
                <span>Download My Data</span>
              </button>
              <button
                type="button"
                onClick={() => navigate('/user/settings')}
                className="profile-account-action-card"
              >
                <Key className="w-4 h-4 text-[#6D28D9]" />
                <span>Change Password</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteAcknowledged(false);
                  setConfirmDeleteAccount(true);
                }}
                data-no-global-confirm="true"
                className="profile-account-action-card profile-account-action-card--danger"
              >
                <Trash2 className="w-4 h-4 text-red-600" />
                <span>Delete Account</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setConfirmLogout(true)}
              data-no-global-confirm="true"
              className="profile-logout-link"
            >
              <LogOut className="w-4 h-4" />
              Log out of this device
            </button>
          </div>
        </div>
          </div>

          <aside className="profile-layout-aside">
            <div className="profile-address-panel">
              <div className="profile-address-panel-header">
                <h2 className="profile-address-title">My Addresses</h2>
                <button
                  type="button"
                  onClick={() => navigate('/user/addresses')}
                  className="profile-address-add-link"
                >
                  <Plus className="w-4 h-4" />
                  Add New Address
                </button>
              </div>

              {addressesLoading ? (
                <ListSkeleton rows={2} withAvatar={false} />
              ) : addresses.length === 0 ? (
                <div className="profile-address-empty">
                  <MapPin className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-600 font-medium">No saved addresses</p>
                  <p className="text-xs text-slate-400 mt-1 mb-4">Add a delivery address for faster checkout</p>
                  <button
                    type="button"
                    onClick={() => navigate('/user/addresses')}
                    className="profile-address-manage-btn w-full"
                  >
                    Add New Address
                  </button>
                </div>
              ) : (
                <div className="profile-address-list">
                  {addresses.slice(0, 3).map((address) => {
                    const { line1, line2, country } = formatAddressLine(address);
                    return (
                      <div key={address.id} className="profile-address-card">
                        <div className="flex gap-3">
                          <div className="profile-address-icon-box">
                            {getAddressTypeIcon(address.address_type)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <span className="text-xs font-semibold text-slate-700 capitalize">
                                {address.address_type || 'home'}
                              </span>
                              {address.is_default && (
                                <span className="profile-address-default-badge">Default</span>
                              )}
                            </div>
                            <p className="text-sm font-semibold text-slate-900">{address.full_name}</p>
                            {line1 && <p className="text-xs text-slate-500 mt-1 leading-relaxed">{line1}</p>}
                            {line2 && <p className="text-xs text-slate-500 leading-relaxed">{line2}</p>}
                            {country && <p className="text-xs text-slate-500 leading-relaxed">{country}</p>}
                            {address.phone_number && (
                              <p className="text-xs text-slate-500 mt-1">{address.phone_number}</p>
                            )}
                          </div>
                        </div>
                        <div className="profile-address-card-actions">
                          <button
                            type="button"
                            onClick={() => navigate('/user/addresses')}
                            className="profile-address-link-btn"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => navigate('/user/addresses')}
                            className="profile-address-link-btn profile-address-link-btn--danger"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {addresses.length > 0 && (
                <button
                  type="button"
                  onClick={() => navigate('/user/addresses')}
                  className="profile-address-manage-btn w-full mt-4"
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  Manage Addresses
                </button>
              )}
            </div>
          </aside>
        </div>

        {confirmLogout && (
          <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="logout-confirm-title">
            <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm border border-slate-100">
              <h3 id="logout-confirm-title" className="text-lg font-bold text-slate-900 mb-2">Confirm Logout</h3>
              <p className="text-sm text-slate-600 mb-5">Are you sure you want to log out of your account?</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmLogout(false)}
                  type="button"
                  className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 transition font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => { setConfirmLogout(false); await handleLogout(); }}
                  type="button"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white hover:bg-red-700 transition font-semibold"
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        )}

        {confirmDeleteAccount && (
          <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
            <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md border border-red-100">
              <h3 id="delete-account-title" className="text-lg font-bold text-red-700 mb-2">Delete Account</h3>
              <p className="text-sm text-slate-600 mb-4 leading-relaxed">
                This will permanently remove your profile, order history access, saved addresses, and wishlist.
                This action cannot be undone.
              </p>
              <label className="flex items-start gap-3 cursor-pointer mb-5 p-3 rounded-xl bg-red-50 border border-red-100">
                <input
                  type="checkbox"
                  checked={deleteAcknowledged}
                  onChange={(e) => setDeleteAcknowledged(e.target.checked)}
                  className="w-4 h-4 mt-0.5 rounded border-red-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-slate-700 leading-relaxed">
                  I understand that deleting my account is permanent and all associated data will be lost.
                </span>
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setConfirmDeleteAccount(false);
                    setDeleteAcknowledged(false);
                  }}
                  type="button"
                  className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 transition font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setConfirmDeleteAccount(false);
                    setDeleteAcknowledged(false);
                    navigate('/contact', { state: { subject: 'Account Deletion Request' } });
                  }}
                  disabled={!deleteAcknowledged}
                  type="button"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white hover:bg-red-700 transition font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Delete Account
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      </main>
      <Footer />
      <MobileNav />
    </div>
  );
};

export default Profile;
