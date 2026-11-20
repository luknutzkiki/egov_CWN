import { makeFixtures } from './fixtures/make-fixtures';

/** สร้างไฟล์ทดสอบอัปโหลด (TEST-DATA §11) ใน e2e/fixtures/files ก่อนรันทุก test */
export default async function globalSetup(): Promise<void> {
  makeFixtures();
}
