prefix = "jtran-int-tf"
key_name = "jtran"

cmr_oauth_provider = "launchpad"

system_bucket     = "jtran-int-tf-internal"
buckets = {
  glacier = {
    name = "jtran-int-tf-orca-glacier"
    type = "orca"
  },
  internal = {
    name = "jtran-int-tf-internal"
    type = "internal"
  }
  private = {
    name = "jtran-int-tf-private"
    type = "private"
  }
  protected = {
    name = "jtran-int-tf-protected"
    type = "protected"
  }
  protected-2 = {
    name = "jtran-int-tf-protected-2"
    type = "protected"
  }
  public = {
    name = "jtran-int-tf-public"
    type = "public"
  }
}
orca_default_bucket = "jtran-int-tf-orca-glacier"
