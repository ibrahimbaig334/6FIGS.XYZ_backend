-- Legacy wallet table removed: wallet authentication is now attested
-- end-to-end (tee-login / tee-identify), so the last address-derived hash
-- at rest is gone. Wallet enrolment lives only in TeeWalletBinding.
DROP TABLE IF EXISTS "Wallet";
