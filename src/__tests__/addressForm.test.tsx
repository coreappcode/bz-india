import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AddressForm, { type Address } from '../components/AddressForm';

vi.mock('../lib/shippingDataService', () => ({
  fetchCountries: vi.fn().mockResolvedValue({
    data: [{ id: 'in', country_name: 'India' }],
    error: null,
  }),
}));

describe('AddressForm', () => {
  it('validates required fields and submits a complete new address', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AddressForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    expect(screen.queryByText(/current location/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/address preview/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('full Name is required')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Full name/), 'Test Buyer');
    await user.type(screen.getByLabelText(/Mobile number/), '+919876543210');
    await user.type(screen.getByLabelText(/Email address/), 'buyer@example.com');
    await waitFor(() => expect(screen.getByLabelText(/Country \/ Region/)).toBeEnabled());
    await user.selectOptions(screen.getByLabelText(/Country \/ Region/), 'India');
    await user.type(screen.getByLabelText(/Flat, house/), '12 Main Street');
    await user.type(screen.getByLabelText(/Area, street/), 'Near market');
    await user.type(screen.getByLabelText(/Town \/ City/), 'Kannur');
    await user.type(screen.getByLabelText(/State \/ Province/), 'Kerala');
    await user.type(screen.getByLabelText(/PIN \/ ZIP/), '670702');
    await user.type(screen.getByLabelText(/Delivery instructions/), 'Call first');
    await user.click(screen.getByRole('radio', { name: 'Work' }));
    await user.click(screen.getByRole('checkbox', { name: 'Set as default address' }));
    await user.click(screen.getByRole('button', { name: 'Save address' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      fullName: 'Test Buyer',
      phoneNumber: '+919876543210',
      email: 'buyer@example.com',
      country: 'India',
      streetAddress1: '12 Main Street',
      streetAddress2: 'Near market',
      city: 'Kannur',
      state: 'Kerala',
      postalCode: '670702',
      addressType: 'work',
      deliveryNotes: 'Call first',
      isDefault: true,
    }));
  });

  it('preserves existing address fields when editing and supports cancel', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const address: Address = {
      id: 'address-1', fullName: 'Test Buyer', phoneNumber: '+919876543210',
      email: 'buyer@example.com', country: 'India', streetAddress1: '12 Main Street',
      streetAddress2: 'Near market', city: 'Kannur', state: 'Kerala', postalCode: '670702',
      addressType: 'other', deliveryNotes: 'Call first', isDefault: true,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    };
    render(<AddressForm initialData={address} onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByRole('heading', { name: 'Edit your address' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Other' })).toBeChecked();
    await user.clear(screen.getByLabelText(/Town \/ City/));
    await user.type(screen.getByLabelText(/Town \/ City/), 'Kochi');
    await user.click(screen.getByRole('button', { name: 'Update address' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      ...address, city: 'Kochi', updatedAt: expect.any(String),
    }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
