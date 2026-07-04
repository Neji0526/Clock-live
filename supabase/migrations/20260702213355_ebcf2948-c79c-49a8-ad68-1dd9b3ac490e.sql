CREATE POLICY "Authenticated can read desktop-app-builds"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'desktop-app-builds');