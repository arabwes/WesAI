CREATE UNIQUE INDEX memberships_single_active_owner_idx
  ON memberships(organization_id)
  WHERE role = 'owner' AND status = 'active';
